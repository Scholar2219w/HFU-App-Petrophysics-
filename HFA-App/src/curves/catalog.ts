import type { CurveCategory } from '../types';

// Built-in alias table: mnemonic → canonical family. Users can extend/override
// in the Curve Manager (stored in the project).
export const FAMILIES: Record<string, { label: string; category: CurveCategory; unit?: string }> = {
  DEPTH: { label: 'Depth', category: 'Depth', unit: 'm' },
  GR: { label: 'Gamma Ray', category: 'Gamma Ray', unit: 'gAPI' },
  CGR: { label: 'Computed Gamma Ray', category: 'Gamma Ray', unit: 'gAPI' },
  SP: { label: 'Spontaneous Potential', category: 'SP', unit: 'mV' },
  CALI: { label: 'Caliper', category: 'Caliper', unit: 'in' },
  BS: { label: 'Bit Size', category: 'Caliper', unit: 'in' },
  RHOB: { label: 'Bulk Density', category: 'Density', unit: 'g/cm3' },
  DRHO: { label: 'Density Correction', category: 'Density', unit: 'g/cm3' },
  PEF: { label: 'Photoelectric Factor', category: 'Photoelectric', unit: 'b/e' },
  NPHI: { label: 'Neutron Porosity', category: 'Neutron', unit: 'v/v' },
  DT: { label: 'Compressional Slowness', category: 'Sonic', unit: 'us/ft' },
  DTS: { label: 'Shear Slowness', category: 'Sonic', unit: 'us/ft' },
  RT: { label: 'Deep Resistivity', category: 'Resistivity', unit: 'ohm.m' },
  RM: { label: 'Medium Resistivity', category: 'Resistivity', unit: 'ohm.m' },
  RS: { label: 'Shallow Resistivity', category: 'Resistivity', unit: 'ohm.m' },
  RXO: { label: 'Flushed Zone Resistivity', category: 'Resistivity', unit: 'ohm.m' },
  PHIT: { label: 'Total Porosity', category: 'Porosity', unit: 'v/v' },
  PHIE: { label: 'Effective Porosity', category: 'Porosity', unit: 'v/v' },
  PHID: { label: 'Density Porosity', category: 'Porosity', unit: 'v/v' },
  VSH: { label: 'Shale Volume', category: 'Shale', unit: 'v/v' },
  SW: { label: 'Water Saturation', category: 'Saturation', unit: 'v/v' },
  K: { label: 'Permeability', category: 'Permeability', unit: 'mD' },
  TCMR: { label: 'NMR Total Porosity', category: 'NMR', unit: 'v/v' },
  CMRP: { label: 'NMR Effective Porosity', category: 'NMR', unit: 'v/v' },
  CMFF: { label: 'NMR Free Fluid', category: 'NMR', unit: 'v/v' },
  BFV: { label: 'NMR Bound Fluid', category: 'NMR', unit: 'v/v' },
  T2LM: { label: 'NMR T2 Log-Mean', category: 'NMR', unit: 'ms' },
  KTIM: { label: 'NMR Timur-Coates Perm', category: 'NMR', unit: 'mD' },
  KSDR: { label: 'NMR SDR Perm', category: 'NMR', unit: 'mD' },
  TENS: { label: 'Tension', category: 'Other', unit: 'lbf' },
  PRES: { label: 'Pressure', category: 'Pressure', unit: 'psi' },
  RQI: { label: 'Reservoir Quality Index', category: 'Calculated', unit: 'um' },
  FZI: { label: 'Flow Zone Indicator', category: 'Calculated', unit: 'um' },
  PHIZ: { label: 'Normalized Porosity Index', category: 'Calculated', unit: 'v/v' },
  HFU: { label: 'Hydraulic Flow Unit', category: 'HFU', unit: '' },
};

export const BUILTIN_ALIASES: Record<string, string> = {
  DEPT: 'DEPTH', DEPTH: 'DEPTH', MD: 'DEPTH', TDEP: 'DEPTH', INDEX: 'DEPTH',
  GR: 'GR', HSGR: 'GR', SGR: 'GR', GRC: 'GR', ECGR: 'GR', GR_EDTC: 'GR', GRD: 'GR', GRS: 'GR', GAM: 'GR', GAMMA: 'GR', HGR: 'GR', GR_ARC: 'GR', GRAM: 'GR', GRM1: 'GR',
  CGR: 'CGR', HCGR: 'CGR',
  SP: 'SP', SPBR: 'SP',
  CALI: 'CALI', CAL: 'CALI', HCAL: 'CALI', C1: 'CALI', C2: 'CALI', CALS: 'CALI', LCAL: 'CALI', DCAL: 'CALI',
  BS: 'BS',
  RHOB: 'RHOB', DEN: 'RHOB', RHOZ: 'RHOB', ZDEN: 'RHOB', HRHO: 'RHOB', DENS: 'RHOB', RHO8: 'RHOB', ROBB: 'RHOB', BDCX: 'RHOB',
  DRHO: 'DRHO', HDRA: 'DRHO', ZCOR: 'DRHO', DCOR: 'DRHO',
  PEF: 'PEF', PE: 'PEF', PEFZ: 'PEF', HPRA: 'PEF', PEF8: 'PEF',
  NPHI: 'NPHI', TNPH: 'NPHI', NPOR: 'NPHI', CNC: 'NPHI', NPHS: 'NPHI', HNPO: 'NPHI', CNCF: 'NPHI', NPL: 'NPHI', APLC: 'NPHI', NEU: 'NPHI', NPSS: 'NPHI', NPLS: 'NPHI', TNPB: 'NPHI', BPHI: 'NPHI',
  DT: 'DT', DTC: 'DT', DTCO: 'DT', AC: 'DT', DT4P: 'DT', DTLN: 'DT', DT24: 'DT', DTP: 'DT', SONIC: 'DT',
  DTS: 'DTS', DTSM: 'DTS', DT4S: 'DTS', DTSH: 'DTS',
  RT: 'RT', AT90: 'RT', AF90: 'RT', AO90: 'RT', ILD: 'RT', LLD: 'RT', RD: 'RT', RDEP: 'RT', HDRS: 'RT', RLA5: 'RT', M2R9: 'RT', RES_DEEP: 'RT', RILD: 'RT', RT_HRLT: 'RT', P40H: 'RT', RPCEHM: 'RT', RACEHM: 'RT', RDEEP: 'RT',
  RM: 'RM', AT60: 'RM', AT30: 'RM', ILM: 'RM', LLS: 'RM', RMED: 'RM', HMRS: 'RM', RLA3: 'RM',
  RS: 'RS', AT20: 'RS', AT10: 'RS', RSHAL: 'RS', SFLU: 'RS', RLA1: 'RS',
  RXO: 'RXO', RXOZ: 'RXO', MSFL: 'RXO', RXO8: 'RXO', MCFL: 'RXO', MLL: 'RXO', HMIN: 'RXO',
  PHIT: 'PHIT', PHIT_ND: 'PHIT', PHI_T: 'PHIT', PHIT_D: 'PHIT', TPOR: 'PHIT',
  PHIE: 'PHIE', PHI_E: 'PHIE', EPOR: 'PHIE', PHIE_ND: 'PHIE',
  PHID: 'PHID', DPHI: 'PHID', DPHZ: 'PHID', DPOR: 'PHID',
  VSH: 'VSH', VCL: 'VSH', VSHALE: 'VSH', V_SH: 'VSH', VCLGR: 'VSH', VSH_GR: 'VSH',
  SW: 'SW', SWT: 'SW', SWE: 'SW', SWA: 'SW', SW_AR: 'SW',
  K: 'K', PERM: 'K', KLOG: 'K', PERM_LOG: 'K',
  TCMR: 'TCMR', CMRP: 'CMRP', CMRP_3MS: 'CMRP', CMFF: 'CMFF', BFV: 'BFV', CMRB: 'BFV', T2LM: 'T2LM', KTIM: 'KTIM', KSDR: 'KSDR', TCMR_MIN: 'TCMR',
  TENS: 'TENS', TENSION: 'TENS',
  RQI: 'RQI', FZI: 'FZI', PHIZ: 'PHIZ', PHI_Z: 'PHIZ', HFU: 'HFU',
};

const RULES: [RegExp, CurveCategory][] = [
  [/^(DEPT|DEPTH|MD|TVD|TVDSS|INDEX|TIME)$/i, 'Depth'],
  [/(^|_)(HFU|CLUSTER|CLUS)/i, 'HFU'],
  [/(FLAG|MASK|ZONE)/i, 'Flag'],
  [/(RQI|FZI|PHIZ|PHI_Z)/i, 'Calculated'],
  [/(^|_)(CORE|CPOR|CPERM|CK|CPHI)/i, 'Core'],
  [/(CMR|T2|TCMR|BFV|FFV|MRP|KTIM|KSDR|NMR)/i, 'NMR'],
  [/(GR|GAM|SGR|CGR)/i, 'Gamma Ray'],
  [/^SP/i, 'SP'],
  [/(CAL|^C[12]$|^BS$)/i, 'Caliper'],
  [/(PEF|^PE$)/i, 'Photoelectric'],
  [/(RHO|DEN|DRHO|HDRA)/i, 'Density'],
  [/(NPHI|TNPH|NPOR|CNC|NEU|APLC|NPL)/i, 'Neutron'],
  [/^(DT|AC|DTC|DTS|SONIC)/i, 'Sonic'],
  [/(^R[TDSMX]|^AT\d|^AF\d|^AO\d|^IL[DM]|^LL[DS]|RES|MSFL|RXO|^HDRS|^HMRS|^RLA)/i, 'Resistivity'],
  [/(PERM|^K$|^K_|KLOG|KAIR|KH|KV)/i, 'Permeability'],
  [/(PHI|POR)/i, 'Porosity'],
  [/(VSH|VCL)/i, 'Shale'],
  [/(^SW|SXO)/i, 'Saturation'],
  [/(PRES|PRESS|MDT|RFT)/i, 'Pressure'],
  [/(IMG|IMAGE|FMI|OBMI)/i, 'Image'],
];

export function familyOf(mnem: string, user: Record<string, string> = {}): string | undefined {
  const m = mnem.toUpperCase().trim();
  if (user[m]) return user[m];
  if (BUILTIN_ALIASES[m]) return BUILTIN_ALIASES[m];
  const base = m.replace(/[_.\-]?(\d+|CORR|COR|EDTC|FINAL|FIN|MAIN|REP|R\d)$/i, '');
  if (base !== m && BUILTIN_ALIASES[base]) return BUILTIN_ALIASES[base];
  return undefined;
}

export function categorize(mnem: string, unit = '', user: Record<string, string> = {}): CurveCategory {
  const fam = familyOf(mnem, user);
  if (fam && FAMILIES[fam]) return FAMILIES[fam].category;
  for (const [re, cat] of RULES) if (re.test(mnem)) return cat;
  const u = unit.toLowerCase();
  if (/ohm/.test(u)) return 'Resistivity';
  if (/gapi|api/.test(u)) return 'Gamma Ray';
  if (/g\/c/.test(u)) return 'Density';
  if (/us\/f|us\/m/.test(u)) return 'Sonic';
  if (/^md$/.test(u)) return 'Permeability';
  return 'Other';
}

export const CATEGORY_COLORS: Record<string, string> = {
  'Gamma Ray': '#3ecf8e', Resistivity: '#e5534b', Density: '#e5534b', Neutron: '#4ea1ff', Sonic: '#b083f0',
  Porosity: '#39c5cf', Permeability: '#f5a623', NMR: '#f07db5', Caliper: '#9aa4b2', Pressure: '#8bd450',
  Core: '#ffffff', Calculated: '#e8c547', HFU: '#e8c547', Shale: '#8bd450', Saturation: '#6c8cff', SP: '#9aa4b2',
  Photoelectric: '#ff8c42', Depth: '#9aa4b2', Flag: '#9aa4b2', Image: '#9aa4b2', Other: '#9aa4b2',
};

/** Find the best mnemonic in a curve list for a family (first match). */
export function findByFamily(mnems: string[], fam: string, user: Record<string, string> = {}): string | undefined {
  const exact = mnems.find((m) => m.toUpperCase() === fam);
  if (exact) return exact;
  return mnems.find((m) => familyOf(m, user) === fam);
}

/** Binary flag curves (reservoir / bad-hole / net / selection) — discrete, but never HFU or cluster labels. */
export const FLAG_RE = /^(RES_FLAG|BH_FL_|NET_RES|NET_PAY|SEL_|EXTRAP|MAIN_RES)/i;
