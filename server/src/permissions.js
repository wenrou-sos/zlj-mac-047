// 岗位与权限定义
// 权限点按「资源:动作」划分；岗位是权限点的集合，人员可兼多个岗位（权限取并集）
export const ROLES = ['dispatcher', 'sorter', 'exception', 'admin'];

export const ROLE_LABEL = {
  dispatcher: '调度',
  sorter: '分拣',
  exception: '异常处理',
  admin: '管理员',
};

// 业务操作权限点（管理员全量拥有，普通岗位按需分配）
const BUSINESS_PERMS = [
  'vehicle:create',   // 到车预报登记
  'vehicle:action',   // 班次状态推进（到车/卸车/分拣/发车）
  'vehicle:delete',   // 删除预报班次
  'package:create',   // 到件登记
  'package:sort',     // 分拣
  'package:load',     // 装车
  'package:intercept',// 异常拦截
  'package:release',  // 解除拦截
];

export const ROLE_PERMISSIONS = {
  dispatcher: ['vehicle:create', 'vehicle:action', 'vehicle:delete'],
  sorter: ['package:create', 'package:sort', 'package:load'],
  exception: ['package:intercept', 'package:release'],
  admin: [...BUSINESS_PERMS, 'settings:update', 'user:manage', 'audit:view'],
};

// 一组岗位的并集权限
export const permissionsOf = (roles) =>
  [...new Set(roles.flatMap((r) => ROLE_PERMISSIONS[r] || []))];
