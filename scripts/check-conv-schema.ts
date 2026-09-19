async function main() {
  const { prismaBase } = await import("@/lib/prisma-base");
  const cols = await prismaBase.$queryRaw`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'conversations' 
    ORDER BY ordinal_position
  `;
  console.log(JSON.stringify(cols, null, 2));
  process.exit(0);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
