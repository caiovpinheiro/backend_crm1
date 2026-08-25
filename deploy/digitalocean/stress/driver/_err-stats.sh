#!/bin/bash
echo "=== P2002 (Unique constraint) nas ultimas 4h ==="
docker logs crm1-worker-etl-1 --since 4h 2>&1 | grep -c "Unique constraint failed"
echo "=== level=error/fatal nas ultimas 4h ==="
docker logs crm1-worker-etl-1 --since 4h 2>&1 | grep -E '"level":"(error|fatal)"' | tail -6
echo "=== restarts do worker (24h) ==="
docker ps --filter name=worker-etl --format '{{.Status}}'
echo "=== imports concluidos hoje (deal) ==="
docker logs crm1-worker-etl-1 --since 5h 2>&1 | grep -c "Importação de negócios concluída"
