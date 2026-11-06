-- 公司共享审批：历史共享数据回填为「已审批」。
--
-- 0015 之前 visibility = 'shared' 的文档 / 知识卡没有审批记录，
-- 若不回填，新策略下会出现「已共享但 share_status = none」的中间态，
-- 编辑器无法正确显示与回收。这里把它们视为已由 L1 审批通过。
--
-- 幂等：可重复执行。

update documents
   set share_status = 'approved',
       share_reviewed_at = coalesce(share_reviewed_at, now())
 where visibility = 'shared'
   and share_status <> 'approved';

update knowledge_cards
   set share_status = 'approved',
       share_reviewed_at = coalesce(share_reviewed_at, now())
 where visibility = 'shared'
   and share_status <> 'approved';

-- 已经批复的共享必须保持 visibility = shared；否则说明数据被手工改坏，纠正回来
update documents
   set visibility = 'shared'
 where share_status = 'approved'
   and visibility <> 'shared';

update knowledge_cards
   set visibility = 'shared'
 where share_status = 'approved'
   and visibility <> 'shared';
