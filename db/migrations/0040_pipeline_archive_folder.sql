-- 0040 产线归档目录：产线可声明一个语义目录，收口时把交付物强制归档为待确认卡片。
-- 只允许语义目录（03/04/05/06/07/08）；01/02/99 分别属于原始素材、默认卡片与回收站。

ALTER TABLE "pipelines" ADD COLUMN IF NOT EXISTS "archive_folder" text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pipelines_archive_folder'
  ) THEN
    ALTER TABLE "pipelines"
      ADD CONSTRAINT "pipelines_archive_folder" CHECK (
        archive_folder IS NULL
        OR archive_folder IN (
          '03-standards', '04-cases', '05-distill',
          '06-templates', '07-training', '08-retro'
        )
      );
  END IF;
END $$;
