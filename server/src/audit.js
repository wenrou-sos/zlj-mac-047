// 操作审计：关键业务动作记录操作者、对象与变更前后内容
import { query } from './db.js';

/**
 * @param req     请求对象（操作者默认取 req.user，登录等场景可用 opts.actor 显式指定）
 * @param action  动作标识，如 package.intercept
 * @param opts    targetType/targetId 业务对象；before/after 变更前后内容；extra 补充说明
 */
export async function audit(req, action, { actor, targetType = null, targetId = null, before = null, after = null, extra = null } = {}) {
  const who = actor || req.user || null;
  try {
    await query(
      `INSERT INTO audit_logs (actor_id, actor_name, action, target_type, target_id, detail)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        who?.id ?? null,
        who ? (who.displayName ? `${who.displayName}(${who.username})` : who.username) : '系统',
        action,
        targetType,
        targetId != null ? String(targetId) : null,
        JSON.stringify({ before, after, extra }),
      ]
    );
  } catch (e) {
    // 审计写入失败不阻断业务，但保留错误日志
    console.error('[audit] 写入失败:', e.message);
  }
}
