/**
 * Pasta de trabalho de referência dos testes de leitura de planilhas.
 *
 * Os arquivos `matriculados-xlsx-0.18.5.{xlsx,xls,ods}` desta pasta foram
 * gerados por esta mesma função com o `xlsx` 0.18.5 (última versão do
 * registry npm, com advisories sem correção) e pinam o que o CRM lia deles.
 * O teste de ida e volta regenera a pasta com a versão instalada (tarball
 * oficial SheetJS ≥ 0.20.2) e exige a mesma leitura.
 *
 * Cobre o que o import depende: texto formatado (`w`) de CPF com máscara,
 * datas (dd/mm/yyyy e m/d/yy), moeda, percentual, booleanos, fórmula com
 * valor em cache, texto com espaços nas pontas, linha vazia no meio,
 * células ausentes e uma segunda aba que NÃO deve ser lida.
 *
 * Datas entram como serial Excel (não `Date`) para o arquivo não depender
 * do fuso da máquina que o gerou.
 */
type SheetJS = typeof import("xlsx");

/** Serial Excel (sistema 1900) de uma data civil. */
export function excelSerial(y: number, m: number, d: number): number {
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000;
}

export type MatriculadosBookType = "xlsx" | "biff8" | "ods";

export function buildMatriculadosWorkbook(XLSX: SheetJS): import("xlsx").WorkBook {
  const ws = XLSX.utils.aoa_to_sheet([
    ["Nome", "E-mail Principal", "CPF", "RGM", "Data Nascimento", "Data Matrícula", "Valor", "Ativo", "Total", "Obs"],
    ["Ana Souza", "ana@exemplo.com", 0, 20231234, 0, 0, 0, true, 0, "  Olá, mundo  "],
    ["", "", "", "", "", "", "", "", "", ""],
    ["Bia Lima", "", 0, 20235678, 0, 0, 0, false, 0, ""],
    ['Caio "Jr" Melo', "caio@exemplo.com", 0, 0, 0, 0, 0, 0, 0, "linha;com,delimitadores"],
  ]);
  // Células com tipo/formato explícitos — o CRM usa o texto formatado (`w`).
  ws["C2"] = { t: "n", v: 12345678901, z: '000"."000"."000"-"00' };
  ws["E2"] = { t: "n", v: excelSerial(1990, 3, 15), z: "dd/mm/yyyy" };
  ws["F2"] = { t: "n", v: excelSerial(2024, 3, 15), z: "m/d/yy" };
  ws["G2"] = { t: "n", v: 1234.5, z: '"R$ "#,##0.00' };
  ws["I2"] = { t: "n", f: "G2*2", v: 2469 };
  ws["C4"] = { t: "n", v: 98765432100, z: '000"."000"."000"-"00' };
  ws["E4"] = { t: "n", v: excelSerial(2001, 7, 1), z: "dd/mm/yyyy" };
  ws["F4"] = { t: "n", v: excelSerial(2023, 11, 2), z: "m/d/yy" };
  ws["G4"] = { t: "n", v: 0.5, z: "0.00%" };
  ws["I4"] = { t: "n", f: "G4*2", v: 1 };
  // Linha 5: células ausentes no meio (C5..I5 não existem na planilha).
  for (const addr of ["C5", "D5", "E5", "F5", "G5", "H5", "I5"]) delete ws[addr];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Matriculados");
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([["Outra"], ["nao deve ser lida"]]),
    "Outra",
  );
  return wb;
}
