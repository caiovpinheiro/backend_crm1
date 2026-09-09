export async function processPendingDistributionQueue(opts: {
  trigger: PendingQueueTrigger;
  /** Quando informado, restringe a drenagem aos departamentos desta pessoa. */
  userId?: string | null;
}): Promise<RetryResult> {
  const orgId = getOrgIdOrNull();
  if (!orgId) {
    return { resolved: 0, cancelled: 0, pending: 0, trigger: opts.trigger };
  }

  const state = getDrainState(orgId);
  if (triggerClearsFruitlessCooldown(opts.trigger)) {
    clearFruitlessCooldown(state, orgId);
  } else if (
    shouldSkipScheduledFruitlessCooldown(
      opts.trigger,
      fruitlessCooldownIsArmed(state.cooldownReason),
    )
  ) {
    logCooldownSkip(orgId, state, opts.trigger, "process");
    return {
      resolved: 0,
      cancelled: 0,
      pending: 0,
      trigger: opts.trigger,
      skipReason: "COOLDOWN",
      skipMessage:
        "Reprocesso adiado — última passagem não encontrou consultor com vaga.",
    };
  }

  if (opts.trigger === "capacity_released") {
    // Gate ANTES do cooldown de 30s: se o consultor agora tem vaga,
    // drena mesmo com fruitless armado. Retenção (1 membro) só saía
    // no Reprocessar porque o outbound caía no skip.
    const gate = await evaluateCapacityReleasedDrain({
      userId: opts.userId ?? null,
    });
    if (!gate.proceed) {
      armFruitlessCooldown(state, "AT_CAPACITY", orgId);
      debugInfo(
        "[distribution] processPending skip — at capacity",
        () => JSON.stringify({
          orgId,
          trigger: opts.trigger,
          userId: opts.userId ?? null,
          load: gate.load,
          volume: gate.volume,
        }),
      );
      return {
        resolved: 0,
        cancelled: 0,
        pending: 0,
        trigger: opts.trigger,
        skipReason: "AT_CAPACITY",
        skipMessage: "Fila do consultor no teto — sem vaga para drenar.",
      };
    }
    clearFruitlessCooldown(state, orgId);
  } else if (shouldSkipCapacityReleasedCooldown(opts.trigger, state.cooldownUntil)) {
    logCooldownSkip(orgId, state, opts.trigger, "process");
    return {
      resolved: 0,
      cancelled: 0,
      pending: 0,
      trigger: opts.trigger,
      skipReason: "COOLDOWN",
      skipMessage:
        "Reprocesso adiado — última passagem não encontrou consultor com vaga.",
    };
  }

  if (state.running) {
    const pending = await prisma.conversation.count({
      where: await getWaitingQueueWhere(),
    });
    // Manual: não mente "ninguém elegível" — a drenagem já está no ar.
    if (opts.trigger === "manual") {
      return {
        resolved: 0,
        cancelled: 0,
        pending,
        trigger: opts.trigger,
        skipReason: "ALREADY_RUNNING",
        skipMessage:
          "A fila já está sendo reprocessada. Tente de novo em instantes.",
      };
    }
    // Coalesca: marca para re-rodar ao terminar.
    // 2º evento enquanto roda → amplia (todos os depts com elegível),
    // para não perder o dept de outro consultor que ficou elegível.
    if (!state.coalesceLogged) {
      state.coalesceLogged = true;
      debugInfo(
        "[distribution] processPending coalesce — already running",
        () => JSON.stringify({
          orgId,
          trigger: opts.trigger,
          queuedTrigger: state.queuedTrigger,
          userId: opts.userId ?? null,
          pending,
        }),
      );
    }
    if (state.queuedTrigger) {
      state.queuedUserId = null;
    } else {
      state.queuedUserId = opts.userId ?? null;
    }
    state.queuedTrigger = opts.trigger;
    return { resolved: 0, cancelled: 0, pending, trigger: opts.trigger };
  }

  state.running = true;
  state.coalesceLogged = false;
  try {
    const widgetActive = await hasOrganizationWidget("smart_distribution");
    debugWarn(
      "[DBG-e46688 retry] widget check",
      () => JSON.stringify({
        widgetActive,
        trigger: opts.trigger,
        userId: opts.userId ?? null,
      }),
    );
    if (!widgetActive || !(await isDistributionEnabled())) {
      return { resolved: 0, cancelled: 0, pending: 0, trigger: opts.trigger };
    }

    let cancelledOrphans = 0;
    try {
      cancelledOrphans = await cancelStalePendingOrphans(orgId);
      if (cancelledOrphans > 0) {
        debugInfo(
          "[distribution] cancelStalePendingOrphans",
          () => JSON.stringify({
            orgId,
            trigger: opts.trigger,
            cancelled: cancelledOrphans,
          }),
        );
      }
    } catch (e) {
      console.warn("[distribution] cancelStalePendingOrphans failed", e);
    }

    let views: Awaited<ReturnType<typeof getDistributionResponsibles>> = [];
    try {
      views = await getDistributionResponsibles();
    } catch (e) {
      console.warn(
        "[distribution] processPending eligibility precheck failed",
        e,
      );
    }
    const eligible = views.filter((r) => r.eligible);

    if (eligible.length === 0) {
      const pending = await prisma.conversation.count({
        where: await getWaitingQueueWhere(),
      });
      debugInfo(
        "[distribution] processPending skip — nenhum consultor elegível",
        () => JSON.stringify({
          orgId,
          trigger: opts.trigger,
          pending,
          cancelledOrphans,
        }),
      );
      armFruitlessCooldown(state, "NO_ELIGIBLE_RESPONSIBLE", orgId);
      return {
        resolved: 0,
        cancelled: cancelledOrphans,
        pending,
        trigger: opts.trigger,
        skipReason: "NO_ELIGIBLE_RESPONSIBLE",
        skipMessage: "Ainda não há responsável elegível para a fila.",
      };
    }

    // Depts a drenar nesta passagem.
    let targetDeptIds: string[] = [];
    let includeOrgWide = false;

    if (opts.userId) {
      const focus = views.find((r) => r.userId === opts.userId);
      if (!focus?.eligible) {
        const pending = await prisma.conversation.count({
          where: await getWaitingQueueWhere(),
        });
        debugInfo(
          "[distribution] processPending skip — userId não elegível",
          () => JSON.stringify({
            orgId,
            trigger: opts.trigger,
            userId: opts.userId,
            pending,
          }),
        );
        // Não arma fruitless org-wide: o consultor cheio não pode
        // congelar a drenagem dos outros departamentos (Retenção no
        // teto parava SAC/Acolhimento e o próprio `capacity_released`).
        return {
          resolved: 0,
          cancelled: cancelledOrphans,
          pending,
          trigger: opts.trigger,
        };
      }
      targetDeptIds = focus.departments.map((d) => d.id);
      // Sem dept: pode receber leads org-wide (sem departmentId na conversa).
      includeOrgWide = targetDeptIds.length === 0;
      // Com dept(s): também tenta org-wide (pool humano elegível inclui esta pessoa).
      if (targetDeptIds.length > 0) includeOrgWide = true;
    } else {
      const deptSet = new Set<string>();
      for (const r of eligible) {
        for (const d of r.departments) deptSet.add(d.id);
      }
      // Também drena depts que JÁ têm gente na espera — senão Acolhimento
      // (ou qualquer depto sem membro no KPI) nunca é tentado.
      const waitingDepts = await prisma.conversation.findMany({
        where: await getWaitingQueueWhere(),
        select: { departmentId: true },
      });
      for (const w of waitingDepts) {
        if (w.departmentId) deptSet.add(w.departmentId);
      }
      targetDeptIds = Array.from(deptSet);
      includeOrgWide = true;
    }

    let resolved = 0;
    let scanned = 0;
    /** Atribuições bem-sucedidas nesta passagem, por consultor (capacidade global). */
    const assignedDeltaByUser = new Map<string, number>();

    const drainBucket = async (departmentId: string | null) => {
      // Sem membro elegível neste depto: ainda puxa o lote com capacidade
      // org-wide. O motor aplica respectDepartment (atribui ou recusa).
      const inDept = eligibleInDeptScope(eligible, departmentId);
      const capDeptId = inDept.length > 0 ? departmentId : null;

      if (
        !hasRemainingCapacityInScope(
          eligible,
          capDeptId,
          assignedDeltaByUser,
        )
      ) {
        return;
      }

      let take = takeLimitForDept(
        eligible,
        capDeptId,
        assignedDeltaByUser,
      );

      if (take <= 0) return;

      // Também drena conversas ainda na IA com DistributionPending PENDING
      // (handoff noturno: a IA reassumiu para continuar o atendimento, mas
      // o lead precisa ir ao humano quando alguém ficar elegível).
      // Tag "Agente IA" / assignee AI NÃO bloqueia reprocesso humano.
      const pendingOwnedByAi = await prisma.distributionPending.findMany({
        where: {
          organizationId: orgId,
          status: "PENDING",
          conversationId: { not: null },
        },
        select: { conversationId: true },
        take: 500,
      });
      const pendingAiConvIds = pendingOwnedByAi
        .map((p) => p.conversationId)
        .filter((id): id is string => Boolean(id));

      const items = await prisma.conversation.findMany({
        where: {
          lastInboundAt: { not: null },
          ...activeInboxQueueGuardWhere(),
          departmentId: departmentId === null ? null : departmentId,
          OR: [
            { assignedToId: null },
            ...(pendingAiConvIds.length > 0
              ? [
                  {
                    id: { in: pendingAiConvIds },
                    assignedTo: { type: "AI" as const },
                  },
                ]
              : []),
          ],
        },
        orderBy: { createdAt: "asc" },
        select: { id: true, contactId: true, departmentId: true },
        take,
      });
      scanned += items.length;

      for (const it of items) {
        if (
          !hasRemainingCapacityInScope(
            eligible,
            departmentId,
            assignedDeltaByUser,
          )
        ) {
          debugInfo(
            "[distribution] processPending cap — scope capacity exhausted",
            () => JSON.stringify({
              orgId,
              trigger: opts.trigger,
              userId: opts.userId ?? null,
              departmentId,
              assignedDeltaByUser: Object.fromEntries(assignedDeltaByUser),
            }),
          );
          break;
        }

        try {
          const result = await executeDistribution({
            dealId: null,
            contactId: it.contactId,
            conversationId: it.id,
            distributionType: null,
            triggerSource: "SYSTEM",
            departmentId: it.departmentId,
            // Handoff com IA ainda assignee (após fila noturna) precisa reassign.
            reassign: true,
            allowOrgWideFallback: false,
          });
          debugWarn(
            "[DBG-e46688 retry] executeDistribution",
            () => JSON.stringify({
              convId: it.id,
              departmentId: it.departmentId,
              success: result.success,
              reason: result.reason,
              selectedUserId: result.selectedUserId,
            }),
          );
          if (result.success) {
            resolved++;
            if (result.selectedUserId) {
              const uid = result.selectedUserId;
              assignedDeltaByUser.set(
                uid,
                (assignedDeltaByUser.get(uid) ?? 0) + 1,
              );

              if (opts.userId && uid === opts.userId) {
                const focus = eligible.find((r) => r.userId === opts.userId);
                if (
                  focus &&
                  liveFreeCapacityForUser(focus, assignedDeltaByUser) <= 0
                ) {
                  debugInfo(
                    "[distribution] processPending cap — user budget exhausted",
                    () => JSON.stringify({
                      orgId,
                      trigger: opts.trigger,
                      userId: opts.userId,
                      departmentId,
                      assignedInPass: assignedDeltaByUser.get(opts.userId) ?? 0,
                    }),
                  );
                }
              }
            }
          } else if (
            result.reason === "NO_ELIGIBLE_RESPONSIBLE" ||
            result.reason === "NO_DEPARTMENT"
          ) {
            // Capacidade do dept esgotou nesta passagem — para o bucket.
            break;
          }
        } catch (e) {
          console.error(
            "[distribution] processPendingDistributionQueue item failed",
            {
              conversationId: it.id,
              trigger: opts.trigger,
              err: e,
            },
          );
        }
      }
    };

    for (const deptId of targetDeptIds) {
      await drainBucket(deptId);
    }
    if (includeOrgWide) {
      await drainBucket(null);
    }

    const waitingBase = await getWaitingQueueWhere();
    const pending = await prisma.conversation.count({
      where: waitingBase,
    });
    const scopeOr: Prisma.ConversationWhereInput[] = [];
    if (targetDeptIds.length > 0) {
      scopeOr.push({ departmentId: { in: targetDeptIds } });
    }
    if (includeOrgWide) scopeOr.push({ departmentId: null });
    const pendingInScope =
      scopeOr.length === 0
        ? 0
        : await prisma.conversation.count({
            where: { AND: [waitingBase, { OR: scopeOr }] },
          });

    let skipReason: string | null = null;
    let skipMessage: string | null = null;
    if (resolved === 0 && pending > 0) {
      const explained = await explainEmptyDrain({
        eligible,
        pendingCount: pending,
      });
      skipReason = explained.skipReason;
      skipMessage = explained.skipMessage;
    }

    // Fruitless só olha a espera DOS depts desta passagem. Contar a org
    // inteira fazia um outbound do SAC armar cooldown enquanto a Retenção
    // (único membro no teto) ficava presa até o Reprocessar manual.
    if (fruitlessPassNeedsCooldown({ resolved, pending: pendingInScope })) {
      armFruitlessCooldown(state, skipReason ?? "NO_ASSIGN", orgId);
    } else {
      clearFruitlessCooldown(state, orgId);
    }

    if (
      resolved > 0 ||
      cancelledOrphans > 0 ||
      opts.trigger === "manual" ||
      opts.trigger === "scheduled"
    ) {
      debugInfo(
        "[distribution] processPendingDistributionQueue",
        () => JSON.stringify({
          orgId,
          trigger: opts.trigger,
          userId: opts.userId ?? null,
          targetDeptIds,
          includeOrgWide,
          resolved,
          cancelledOrphans,
          pending,
          scanned,
          skipReason,
        }),
      );
    }

    return {
      resolved,
      cancelled: cancelledOrphans,
      pending,
      trigger: opts.trigger,
      skipReason,
      skipMessage,
    };
  } finally {
    state.running = false;
    const queued = state.queuedTrigger;
    const queuedUserId = state.queuedUserId;
    state.queuedTrigger = null;
    state.queuedUserId = null;
    // Só re-drena se alguém ficou elegível / capacidade / manual.
    // `new_item` NÃO reentra sozinho — evita loop quando a fila está
    // cheia e ninguém ONLINE.
    // `capacity_released` após passagem vazia: não agenda retry. A
    // próxima varredura é agent_online / elegível / new_item / manual.
    const queuedCapacityOnCooldown =
      queued === "capacity_released" &&
      shouldSkipCapacityReleasedCooldown(queued, state.cooldownUntil) &&
      !shouldScheduleRetryOnCooldownSkip();
    if (queuedCapacityOnCooldown) {
      logCooldownSkip(orgId, state, queued, "requeue");
    } else if (
      queued &&
      (queued === "agent_online" ||
        queued === "agent_eligible" ||
        queued === "capacity_released" ||
        queued === "manual")
    ) {
      scheduleProcessPendingDistributionQueue({
        trigger: queued,
        delayMs: 500,
        userId: queuedUserId,
      });
    }
  }
}

/**
 * Compat: botão "Reprocessar agora" e callers legados.
 */
export async function retryPendingDistributions(): Promise<RetryResult> {
  return enqueueProcessPendingOrRun({ trigger: "manual" });
}

/**
 * Enfileira drenagem no `worker-distribution`. Fallback síncrono só em
 * test/dev — em prod (`APP_MODE=api`) a API nunca drena in-process.
 */
export async function enqueueProcessPendingOrRun(opts: {
  trigger: PendingQueueTrigger;
  userId?: string | null;
}): Promise<RetryResult> {
  const orgId = getOrgIdOrNull();
  if (!orgId) {
    return { resolved: 0, cancelled: 0, pending: 0, trigger: opts.trigger };
  }

  const state = getDrainState(orgId);
  if (triggerClearsFruitlessCooldown(opts.trigger)) {
    clearFruitlessCooldown(state, orgId);
  } else if (shouldSkipCapacityReleasedCooldown(opts.trigger, state.cooldownUntil)) {
    const bypassed = await bypassFruitlessIfUserHasSlot(
      orgId,
      state,
      opts.userId,
    );
    if (!bypassed) {
      logCooldownSkip(orgId, state, opts.trigger, "schedule");
      return {
        resolved: 0,
        cancelled: 0,
        pending: 0,
        trigger: opts.trigger,
        skipReason: "COOLDOWN",
        skipMessage:
          "Reprocesso adiado — última passagem não encontrou consultor com vaga.",
      };
    }
  } else if (opts.trigger === "scheduled") {
    const fruitless =
      fruitlessCooldownIsArmed(state.cooldownReason) ||
      (await peekPublishedFruitlessCooldown(orgId)).armed;
    if (shouldSkipScheduledFruitlessCooldown(opts.trigger, fruitless)) {
      logCooldownSkip(orgId, state, opts.trigger, "schedule");
      return {
        resolved: 0,
        cancelled: 0,
        pending: 0,
        trigger: opts.trigger,
        skipReason: "COOLDOWN",
        skipMessage:
          "Reprocesso adiado — última passagem não encontrou consultor com vaga.",
      };
    }
  } else if (opts.trigger === "capacity_released") {
    // Cross-process: worker arma `dist:fruitless:{org}`; a API (outro
    // processo) não tem cooldownUntil local — sem este peek cada send
    // re-ADDiciona `dd-{org}-capacity_released`.
    let fruitless = fruitlessCooldownIsArmed(state.cooldownReason);
    let ttlMs: number | null =
      state.cooldownUntil > Date.now()
        ? Math.max(0, state.cooldownUntil - Date.now())
        : null;
    if (!fruitless) {
      try {
        const peeked = await peekPublishedFruitlessCooldown(orgId);
        fruitless = peeked.armed;
        if (peeked.ttlMs != null) ttlMs = peeked.ttlMs;
      } catch (e) {
        console.warn("[distribution] peek fruitless cooldown failed", e);
        fruitless = false;
      }
    }
    let userHasFreeSlot = false;
    if (fruitless) {
      userHasFreeSlot = await bypassFruitlessIfUserHasSlot(
        orgId,
        state,
        opts.userId,
      );
    }
    if (
      shouldSkipCapacityReleasedFruitlessCooldown(
        opts.trigger,
        fruitless,
        userHasFreeSlot,
      )
    ) {
      if (!state.cooldownSkipLogged) {
        state.cooldownSkipLogged = true;
        debugInfo(
          "[distribution] drain enqueue skipped — fruitless cooldown armed",
          () => JSON.stringify({
            orgId,
            trigger: opts.trigger,
            ttlMs,
          }),
        );
      }
      return {
        resolved: 0,
        cancelled: 0,
        pending: 0,
        trigger: opts.trigger,
        skipReason: "COOLDOWN",
        skipMessage:
          "Reprocesso adiado — última passagem não encontrou consultor com vaga.",
      };
    }
  }

  const queued = await enqueueDistributionDrain({
    organizationId: orgId,
    trigger: opts.trigger,
    userId: opts.userId ?? null,
  });
  if (queued) {
    if (isFreshDrainEnqueue(queued)) {
      debugInfo(
        "[distribution] drain enqueued",
        () => JSON.stringify({
          orgId,
          trigger: opts.trigger,
          userId: opts.userId ?? null,
        }),
      );
    }
    return {
      resolved: 0,
      cancelled: 0,
      pending: 0,
      trigger: opts.trigger,
      skipReason: "QUEUED",
      skipMessage:
        "Reprocesso enfileirado — a fila será drenada em instantes.",
    };
  }

  if (allowInlineDistributionFallback()) {
    return processPendingDistributionQueue(opts);
  }

  metrics.errors.inc({
    scope: "distribution.drain",
    kind: "queue_unavailable",
  });
  console.warn(
    "[distribution] drain queue unavailable — skip sync fallback",
    JSON.stringify({
      orgId,
      trigger: opts.trigger,
      userId: opts.userId ?? null,
    }),
  );
  return {
    resolved: 0,
    cancelled: 0,
    pending: 0,
    trigger: opts.trigger,
    skipReason: "QUEUE_UNAVAILABLE",
    skipMessage:
      "Fila de distribuição indisponível. Tente novamente em instantes.",
  };
}

/**
 * Agenda drenagem sem bloquear o caller (presença, enqueue, PATCH, etc.).
 * Debounce por org: vários gatilhos próximos viram uma única execução.
 */
export function scheduleProcessPendingDistributionQueue(opts: {
  trigger: PendingQueueTrigger;
  /** Default 500ms — agrupa rajadas (ex.: vários leads entrando juntos). */
  delayMs?: number;
  /** Restringe aos depts desta pessoa (agent_online / agent_eligible). */
  userId?: string | null;
}): void {
  const orgId = getOrgIdOrNull();
  if (!orgId) return;

  const delayMs = opts.delayMs ?? 500;
  const state = getDrainState(orgId);
  if (triggerClearsFruitlessCooldown(opts.trigger)) {
    clearFruitlessCooldown(state, orgId);
  } else if (
    shouldSkipCapacityReleasedCooldown(opts.trigger, state.cooldownUntil) ||
    shouldSkipScheduledFruitlessCooldown(
      opts.trigger,
      fruitlessCooldownIsArmed(state.cooldownReason),
    )
  ) {
    logCooldownSkip(orgId, state, opts.trigger, "schedule");
    if (!shouldScheduleRetryOnCooldownSkip()) return;
  }

  const armTimer = () => {
    // Debounce por org: vários gatilhos próximos viram uma única execução.
    state.queuedTrigger = opts.trigger;
    if (
      opts.userId &&
      state.queuedUserId &&
      opts.userId !== state.queuedUserId
    ) {
      state.queuedUserId = null;
    } else if (!opts.userId) {
      state.queuedUserId = null;
    } else if (!state.timer) {
      state.queuedUserId = opts.userId;
    } else if (state.queuedUserId === opts.userId) {
      state.queuedUserId = opts.userId;
    }

    if (state.timer) {
      clearTimeout(state.timer);
    }

    state.timer = setTimeout(() => {
      state.timer = null;
      const trigger = state.queuedTrigger ?? opts.trigger;
      const userId = state.queuedUserId;
      state.queuedTrigger = null;
      state.queuedUserId = null;

      void runWithContext(
        {
          organizationId: orgId,
          userId: "system",
          isSuperAdmin: false,
          actor: {
            type: "SYSTEM",
            label: "Distribuição Inteligente",
            sublabel: `queue:${trigger}`,
          },
        },
        () => enqueueProcessPendingOrRun({ trigger, userId }),
      ).catch((e) => {
        console.error(
          "[distribution] scheduleProcessPendingDistributionQueue failed",
          e,
        );
      });
    }, delayMs);

    if (typeof state.timer === "object" && state.timer && "unref" in state.timer) {
      try {
        state.timer.unref();
      } catch {
        /* ignore */
      }
    }
  };

  armTimer();
}
