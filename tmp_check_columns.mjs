import pg from 'pg';
const { Client } = pg;
const c = new Client({ connectionString: 'postgresql://crm:hp18gkbaxnh37wg833kx@31.97.91.47:5433/crm?sslmode=disable' });
await c.connect();
const res = await c.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('ai_agent_config_versions','ai_simple_conversation_states','ai_agent_knowledge_docs') ORDER BY table_name, ordinal_position`);
console.log(JSON.stringify(res.rows, null, 2));
await c.end();
