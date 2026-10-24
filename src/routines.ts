// CALL / SELECT script for running a routine with the values typed in the parameters dialog.

export interface RoutineParam { mode: string; name: string; type: string }
export interface ParamValue { value: string; isNull: boolean; expr: boolean }

const qi = (s: string) => '`' + s.replace(/`/g, '``') + '`';
const NUMERIC = /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|dec|fixed|float|double|real|bit|year|bool|boolean)\b/i;
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** SQL literal for a typed value: numbers as they are for numeric types, everything else quoted. */
export function literal(type: string, v: ParamValue) {
  if (v.isNull) return 'NULL';
  if (v.expr) return v.value.trim() || 'NULL';
  const t = v.value.trim();
  if (NUMERIC.test(type) && NUMBER.test(t)) return t;
  return "'" + v.value.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
}

const variable = (name: string) => '@' + name.replace(/[^\w$]/g, '_');

/**
 * Procedure: OUT/INOUT parameters go through user variables (INOUT set first) and are selected after
 * the CALL. Function: one SELECT.
 */
export function callScript(db: string, kind: 'procedure' | 'function', name: string, params: RoutineParam[], values: ParamValue[]) {
  const target = `${qi(db)}.${qi(name)}`;
  if (kind === 'function') return `SELECT ${target}(${params.map((p, i) => literal(p.type, values[i])).join(', ')}) AS ${qi(name)};\n`;
  const lines: string[] = [];
  const outs: string[] = [];
  const args = params.map((p, i) => {
    const mode = p.mode.toUpperCase();
    if (mode === 'IN') return literal(p.type, values[i]);
    const v = variable(p.name);
    lines.push(`SET ${v} = ${mode === 'INOUT' ? literal(p.type, values[i]) : 'NULL'};`);
    outs.push(`${v} AS ${qi(p.name)}`);
    return v;
  });
  lines.push(`CALL ${target}(${args.join(', ')});`);
  if (outs.length) lines.push(`SELECT ${outs.join(', ')};`);
  return lines.join('\n') + '\n';
}
