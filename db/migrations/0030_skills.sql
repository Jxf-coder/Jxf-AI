-- 技能注册表与首批 5 个 Skill
--
-- 设计目标：
--   1. skills 是唯一真相源：内置技能（tenant_id = null）与租户自建技能共存；
--   2. skill_runs 记录每次执行的输入/输出/状态，便于审计与追溯；
--   3. 绑定关系仍落在 department_packs.skill_ids 与 ai_employees.skill_keys，
--      应用层用 skills 校验，禁止悬空字符串；
--   4. Meta 投放与多平台分发各自建表，密钥只存密文/哈希；
--   5. 发布机通过 SECURITY DEFINER 函数领取任务，业务角色不直接改任务状态。

CREATE TABLE IF NOT EXISTS "skills" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid,
  "key" text NOT NULL,
  "name" text NOT NULL,
  "icon" text DEFAULT '🧩' NOT NULL,
  "category" text DEFAULT 'tool' NOT NULL,
  "summary" text DEFAULT '' NOT NULL,
  "hint" text DEFAULT '' NOT NULL,
  "prompt_body" text DEFAULT '' NOT NULL,
  "config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "origin" text DEFAULT 'builtin' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "department_id" uuid,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skills_key_shape" CHECK ("key" ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  CONSTRAINT "skills_status" CHECK ("status" in ('active', 'draft', 'retired')),
  CONSTRAINT "skills_origin" CHECK ("origin" in ('builtin', 'tenant')),
  CONSTRAINT "skills_category" CHECK (
    "category" in ('creation', 'production', 'expert', 'video', 'knowledge', 'music', 'tool', 'learning', 'teaching', 'finance', 'admin')
  ),
  CONSTRAINT "skills_version" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "skills_key_unique" ON "skills" ("key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skills_tenant_idx" ON "skills" ("tenant_id", "category", "updated_at" DESC);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "skill_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "department_id" uuid NOT NULL,
  "skill_id" uuid NOT NULL,
  "skill_key" text NOT NULL,
  "kind" text DEFAULT 'prompt' NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,
  "input" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "output" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "error" text,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  CONSTRAINT "skill_runs_status" CHECK ("status" in ('running', 'done', 'failed')),
  CONSTRAINT "skill_runs_kind" CHECK ("kind" in ('prompt', 'meta_sync', 'meta_report', 'distribute')),
  CONSTRAINT "skill_runs_skill_fk" FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_runs_skill_idx" ON "skill_runs" ("tenant_id", "skill_key", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_runs_department_idx" ON "skill_runs" ("tenant_id", "department_id", "created_at" DESC);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "skill_runtime_tokens" (
  "tenant_id" uuid NOT NULL,
  "skill_key" text NOT NULL,
  "token_hash" text NOT NULL,
  "token_hint" text NOT NULL,
  "updated_by" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("tenant_id", "skill_key")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "skill_meta_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "department_id" uuid NOT NULL,
  "account_id" text NOT NULL,
  "account_name" text,
  "currency" text,
  "timezone" text,
  "token_enc" text NOT NULL,
  "token_hint" text,
  "relay_url" text,
  "relay_token_enc" text,
  "settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "connected_by" uuid,
  "connected_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_meta_connections_account" CHECK ("account_id" ~ '^[0-9]{5,32}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "skill_meta_connections_scope_unique"
  ON "skill_meta_connections" ("tenant_id", "department_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "skill_meta_drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "department_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "target_id" text NOT NULL,
  "target_name" text NOT NULL,
  "campaign_name" text,
  "title" text NOT NULL,
  "reason" text NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "source" text DEFAULT 'rule' NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "error" text,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "decided_at" timestamp with time zone,
  "decided_by" uuid,
  CONSTRAINT "skill_meta_drafts_kind" CHECK ("kind" in ('pause_ad', 'resume_ad', 'set_budget')),
  CONSTRAINT "skill_meta_drafts_status" CHECK ("status" in ('pending', 'executing', 'executed', 'failed', 'dismissed')),
  CONSTRAINT "skill_meta_drafts_source" CHECK ("source" in ('rule', 'ai', 'manual', 'auto'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_meta_drafts_pending_idx"
  ON "skill_meta_drafts" ("tenant_id", "department_id", "status", "created_at" DESC);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "skill_distribute_groups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "department_id" uuid NOT NULL,
  "name" text NOT NULL,
  "lane_cn" text,
  "lane_overseas" text,
  "copy_defaults" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_distribute_groups_name_len" CHECK (char_length("name") between 1 and 40)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "skill_distribute_groups_unique"
  ON "skill_distribute_groups" ("tenant_id", "department_id", "name");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "skill_distribute_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "department_id" uuid NOT NULL,
  "group_id" uuid NOT NULL,
  "platform" text NOT NULL,
  "display_name" text NOT NULL,
  "hostname" text,
  "logged_in" boolean DEFAULT false NOT NULL,
  "copy_profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_distribute_accounts_platform" CHECK (
    "platform" in ('douyin', 'channels', 'xhs', 'kuaishou', 'bilibili', 'facebook', 'instagram', 'tiktok', 'youtube')
  ),
  CONSTRAINT "skill_distribute_accounts_group_fk"
    FOREIGN KEY ("group_id") REFERENCES "skill_distribute_groups"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_distribute_accounts_group_idx"
  ON "skill_distribute_accounts" ("tenant_id", "group_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "skill_distribute_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "department_id" uuid NOT NULL,
  "title" text NOT NULL,
  "body" text DEFAULT '' NOT NULL,
  "tags" text[] DEFAULT '{}'::text[] NOT NULL,
  "platforms" text[] DEFAULT '{}'::text[] NOT NULL,
  "copies" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "run_at" timestamp with time zone,
  "ai_generated" boolean DEFAULT false NOT NULL,
  "results" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "error" text,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  CONSTRAINT "skill_distribute_jobs_status" CHECK ("status" in ('queued', 'scheduled', 'running', 'done', 'error')),
  CONSTRAINT "skill_distribute_jobs_title_len" CHECK (char_length("title") between 1 and 120)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_distribute_jobs_queue_idx"
  ON "skill_distribute_jobs" ("tenant_id", "status", "run_at" NULLS FIRST, "created_at");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 发布机领取 / 回写任务（令牌只存 SHA-256，业务角色不直接改任务状态）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.distribute_runner_claim(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant uuid;
  v_job skill_distribute_jobs%ROWTYPE;
BEGIN
  SELECT tenant_id INTO v_tenant
    FROM skill_runtime_tokens
   WHERE skill_key = 'video-distribute'
     AND token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
   LIMIT 1;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'invalid runner token';
  END IF;

  SELECT * INTO v_job
    FROM skill_distribute_jobs
   WHERE tenant_id = v_tenant
     AND status IN ('queued', 'scheduled')
     AND (run_at IS NULL OR run_at <= now())
   ORDER BY created_at
   LIMIT 1
   FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE skill_distribute_jobs
     SET status = 'running', updated_at = now()
   WHERE id = v_job.id;

  RETURN jsonb_build_object(
    'id', v_job.id,
    'title', v_job.title,
    'body', v_job.body,
    'tags', v_job.tags,
    'platforms', v_job.platforms,
    'copies', v_job.copies,
    'aiGenerated', v_job.ai_generated
  );
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.distribute_runner_report(
  p_token text,
  p_job_id uuid,
  p_status text,
  p_results jsonb DEFAULT '[]'::jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant uuid;
BEGIN
  IF p_status NOT IN ('done', 'error') THEN
    RAISE EXCEPTION 'invalid job status';
  END IF;

  SELECT tenant_id INTO v_tenant
    FROM skill_runtime_tokens
   WHERE skill_key = 'video-distribute'
     AND token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
   LIMIT 1;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'invalid runner token';
  END IF;

  UPDATE skill_distribute_jobs
     SET status = p_status,
         results = coalesce(p_results, '[]'::jsonb),
         updated_at = now(),
         finished_at = now()
   WHERE id = p_job_id
     AND tenant_id = v_tenant
     AND status = 'running';
  RETURN FOUND;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.distribute_runner_claim(text) FROM public;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.distribute_runner_report(text, uuid, text, jsonb) FROM public;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.distribute_runner_claim(text) TO jxf_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.distribute_runner_report(text, uuid, text, jsonb) TO jxf_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 内置 5 个 Skill（tenant_id = null，所有租户可见，应用角色不可改）
-- ---------------------------------------------------------------------------
INSERT INTO "skills" ("tenant_id", "key", "name", "icon", "category", "summary", "hint", "prompt_body", "origin", "status")
VALUES
  (
    NULL, 'customer-research', '客户调研', '🗣️', 'knowledge',
    '针对一家国际客户及其联系人，产出有来源的供应链背景调查报告。',
    '先要公司全称。查不到的格子留空，价格、信用和纠纷没有两条来源就写未核实。',
    $prompt$你是外贸客户背调分析师。一次只调查一家公司，先要求用户给出公司全称。
用公开商业资料交叉核对，每条事实必须注明来源；没有来源的字段留空，不编人数、营收、联系人或信用结论。
价格、信用评级、法律纠纷没有两条以上互相印证的来源时，写「未核实」。
年龄、性格、私人账号没有公开依据就空着；只记录职务相关的公开联系方式。
关键联系人优先角色：老板/决策层、采购经理/总监、技术经理/总监/负责人、Category Manager、Private Label Manager、Procurement Manager、Product Development Manager、Technical Director、Supply Chain Director。

按以下七节输出 Markdown：
一、公司基本信息（全称、注册地址、成立时间、注册资本、企业类型、公司人数、股东结构、管理层人数、主营业务范围、行业地位）
二、近 3 年采购概括（行业关联、中国同行信息/价格、官方网站、海关编码）
三、公司概况与历史（发展历史与定位、近年营收规模及趋势）
四、合规性与信用状况（信用评级、主要合作银行、法律纠纷/负面新闻、行业口碑）
五、社交媒体信息（LinkedIn、Facebook、Twitter/X、Instagram）
六、关键联系人（每人一组：姓名、职位、年龄、性格、Facebook、LinkedIn、邮箱、WhatsApp/电话、Instagram、YouTube、TikTok、Twitter、Kakao Talk、Zalo、中国业务对接人）
七、重要提示（潜在风险点、建议合作方式）$prompt$,
    'builtin', 'active'
  ),
  (
    NULL, 'ima-knowledge', 'IMA知识库', '🗂️', 'learning',
    '按十大库和录音里的企业目录搭建知识库、权限和提问方式。',
    '视频和设计源文件不入库。未决的目录归属保持缺口。',
    $prompt$你是企业知识库治理顾问。先跑通核心闭环，不必一次建完全部库。
顺序：总部建标准 → 一线调用 → 个人沉淀 → 经验回流 → 指定库回答 → 持续更新。
可入库：文档；图片靠文字识别；音频先转写；网页/在线文档以链接入库。视频和设计源文件不入库，只留文字稿、成品图和说明。
权限按库：个人库默认私密；共享库分管理员、可编辑、仅查看；查看与导出分开。
命名：模块、主题、日期、版本；目录尽量两级。十大库为产品、SOP、品牌内容、客户跟进、培训、个人沉淀、个人内容、新媒体、共享、合规运维。没有负责人的库不当成可对外使用。
提问公式：角色 + 指定的库 + 问题 + 输出格式；先打开「只基于知识库回答」并选中库。
发布前四步：对照原文查事实 → 过违禁清单 → 人工去机器腔 → 业务和合规双人确认。
企业一级目录可为：企业介绍、经营主体、产品、新媒体、策划素材、客户画像、销售转化、客户交付、课程。
素材归属、二三级目录、大客户资料、违禁词放置、维护人没有定论时不要补猜。

输出：
- 建议进哪个库
- 目录两级怎么放
- 谁有什么权限
- 一条可直接用的提问
- 还没定的缺口$prompt$,
    'builtin', 'active'
  ),
  (
    NULL, 'learning-knowledge', '学习提炼知识库', '📚', 'learning',
    '脱敏后的来源全文与索引；按编号、标题、对应技能检索。',
    '技能打开时读自己的「脱敏全文」；核对单份出处时读原文。桌面原件不入库。',
    '', 'builtin', 'active'
  ),
  (
    NULL, 'meta-ads-operator', 'Meta 投放', '📣', 'expert',
    'Facebook / Instagram 广告：每天同步成效，按规则评审素材，出关停与调预算草稿，确认后才写入 Meta。',
    '先在「连接与配置」连广告帐户、系统用户 token。够本 → 长窗同意 → 先诊断再开药。',
    '', 'builtin', 'active'
  ),
  (
    NULL, 'video-distribute', '多平台分发', '📡', 'video',
    '分组管号、勾选账号、一条成片一键或定时发到多平台。',
    '服务端按平台分给发布机，登录仍在各机本机分发器。',
    '', 'builtin', 'active'
  )
ON CONFLICT ("key") DO NOTHING;
