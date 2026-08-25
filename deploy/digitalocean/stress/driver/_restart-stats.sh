#!/bin/bash
echo "=== worker-etl inspect ==="
docker inspect crm1-worker-etl-1 --format 'RestartCount={{.RestartCount}} OOMKilled={{.State.OOMKilled}} StartedAt={{.State.StartedAt}}'
echo "=== eventos de morte do worker (24h) ==="
docker events --since 24h --until now --filter container=crm1-worker-etl-1 --filter event=die --filter event=oom --filter event=restart --format '{{.Time}} {{.Action}}' 2>/dev/null | tail -20
echo "=== todos containers: restart count ==="
for c in crm1-worker-etl-1 crm1-api-1 crm1-worker-leads-1 crm1-worker-automation-1; do
  docker inspect "$c" --format "$c restarts={{.RestartCount}} oom={{.State.OOMKilled}}"
done
echo "=== memoria atual ==="
docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}}' | grep -E 'etl|api|leads'
