import type { HeaderItem } from '../types';

export interface ParsedCurve { mnemonic: string; unit: string; description: string; data: Float32Array }

/** Normalized output of every log parser (LAS / DLIS / table-as-log). */
export interface ParsedLog {
  format: string;
  fileName: string;
  fileSize: number;
  wellName: string;
  uwi: string;
  field: string;
  lasVersion?: string;
  nullValue?: number;
  depthUnit: string;
  depthMnemonic: string;
  depth: Float64Array;          // ascending
  curves: ParsedCurve[];
  header: HeaderItem[];
  warnings: string[];
  reversed: boolean;            // original file was in decreasing depth order
  wrap?: boolean;
  otherSections?: string[];
}

export interface TablePreview {
  sheets: string[];
  sheet: string;
  rows: string[][];             // first ~60 rows as text
  delimiter?: string;
  totalRowsEstimate?: number;
}

export interface TableOptions {
  sheet?: string;
  delimiter?: string;           // CSV only; '' = auto
  decimal?: '.' | ',';
  headerRow: number;            // 0-based index of header row
  unitRow: number;              // -1 = none
  dataStart: number;            // first data row index
  nullValues: string[];         // tokens mapped to NaN (e.g. -999.25, NA)
  units?: Record<string, string>;
}

export interface ParsedTable {
  columns: { name: string; unit: string; kind: 'num' | 'text'; num?: Float64Array; text?: string[] }[];
  nRows: number;
  warnings: string[];
}
