# Baseline de system prompts (Onda 0)

Gerado por `npx tsx scripts/dump-agent-prompts.ts`.

Cada arquivo `baseline/<agentId>.txt` é o render estável de um agente
ativo com contexto sintético FIXO. Reexecute o script após mudanças no
motor de prompt; diffs inesperados = pare e investigue.

Se a pasta estiver vazia, o banco local não tem agentes `active=true`.
