-- Mesmo e-mail pode existir em orgs diferentes.
DROP INDEX IF EXISTS "users_email_key";
CREATE UNIQUE INDEX "users_organizationId_email_key" ON "users"("organizationId", "email");
