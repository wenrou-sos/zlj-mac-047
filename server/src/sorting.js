// 分拣规则匹配引擎：按目的地 + 包裹属性（重量区间）匹配规则，给出目标格口与命中原因
// 规则冲突（同级多规则命中）或无匹配时不做决策，由调用方转入待判区
import { query } from './db.js';

// 当前已发布的规则版本及其规则（含格口状态）
export async function getPublishedRules() {
  const [version] = await query(
    `SELECT * FROM rule_versions WHERE status = 'published' ORDER BY version_no DESC LIMIT 1`
  );
  if (!version) return { version: null, rules: [] };
  const rules = await query(
    `SELECT r.*, c.code AS chute_code, c.name AS chute_name, c.status AS chute_status
     FROM sort_rules r JOIN chutes c ON c.id = r.chute_id
     WHERE r.version_id = $1
     ORDER BY r.priority, r.id`,
    [version.id]
  );
  return { version, rules };
}

// 规则描述（命中原因快照文本）
export function describeRule(r) {
  const parts = [r.destination ? `目的地=${r.destination}` : '任意目的地'];
  if (r.min_weight != null || r.max_weight != null) {
    parts.push(`重量 ${r.min_weight ?? 0}~${r.max_weight ?? '∞'}kg`);
  }
  return `命中规则 #${r.id}（${parts.join('，')}）→ 格口 ${r.chute_code}`;
}

/**
 * 评估一个包裹的分拣决策
 * @param pkg   { destination, weight_kg }
 * @param version 规则版本行（可为 null）
 * @param rules 该版本下的规则（含 chute_code/chute_name/chute_status）
 * @returns { outcome: 'routed'|'conflict'|'unmatched', ... }
 */
export function evaluate(pkg, version, rules) {
  const versionNo = version?.version_no ?? null;
  const matched = [];
  const skippedDisabled = [];

  for (const r of rules) {
    if (r.destination && r.destination !== pkg.destination) continue;
    const w = Number(pkg.weight_kg);
    if (r.min_weight != null && w < Number(r.min_weight)) continue;
    if (r.max_weight != null && w >= Number(r.max_weight)) continue;
    // 格口已停用：规则不再生效（等效改道落空），记录原因
    if (r.chute_status !== 'active') {
      skippedDisabled.push(r);
      continue;
    }
    matched.push(r);
  }

  if (matched.length === 0) {
    return {
      outcome: 'unmatched',
      version_no: versionNo,
      reason: skippedDisabled.length
        ? `匹配的规则指向已停用格口（${skippedDisabled.map((r) => r.chute_code).join('、')}），请先改道或人工判定`
        : '没有匹配的分拣规则',
    };
  }

  const topPriority = matched[0].priority;
  const best = matched.filter((r) => r.priority === topPriority);
  if (best.length > 1) {
    return {
      outcome: 'conflict',
      version_no: versionNo,
      candidates: best.map((r) => ({
        rule_id: r.id,
        priority: r.priority,
        chute_code: r.chute_code,
        description: describeRule(r),
      })),
      reason: `规则 ${best.map((r) => '#' + r.id).join(' 与 ')} 优先级相同（${topPriority}）且均匹配，需人工判定`,
    };
  }

  const rule = best[0];
  return {
    outcome: 'routed',
    version_no: versionNo,
    rule,
    chute: { id: rule.chute_id, code: rule.chute_code, name: rule.chute_name },
    reason: describeRule(rule),
  };
}
