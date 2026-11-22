import { readFile, writeFile } from "node:fs/promises";
import { convertDwgToDxf } from "@/lib/dwg2dxf";

const { dxf, dwgVersion, warnings } = await convertDwgToDxf(await readFile("plan.dwg"));
await writeFile("plan.dxf", dxf);