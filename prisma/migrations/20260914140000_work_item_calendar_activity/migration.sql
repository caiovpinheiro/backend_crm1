-- Espelho de checklist/reunião do WiPO Chat no calendário de tarefas (Activity).

ALTER TABLE "team_chat_work_items" ADD COLUMN "calendarActivityId" TEXT;

CREATE UNIQUE INDEX "team_chat_work_items_calendarActivityId_key"
ON "team_chat_work_items"("calendarActivityId");

ALTER TABLE "team_chat_work_items"
ADD CONSTRAINT "team_chat_work_items_calendarActivityId_fkey"
FOREIGN KEY ("calendarActivityId") REFERENCES "activities"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "team_chat_work_item_entries" ADD COLUMN "calendarActivityId" TEXT;

CREATE UNIQUE INDEX "team_chat_work_item_entries_calendarActivityId_key"
ON "team_chat_work_item_entries"("calendarActivityId");

ALTER TABLE "team_chat_work_item_entries"
ADD CONSTRAINT "team_chat_work_item_entries_calendarActivityId_fkey"
FOREIGN KEY ("calendarActivityId") REFERENCES "activities"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
