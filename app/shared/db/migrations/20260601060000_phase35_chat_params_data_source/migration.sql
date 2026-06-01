-- M9.2 (Phase 3.5): add `data_source` ENUM and `media_types` TEXT[] to
-- `chat_params`. Nothing reads these columns yet — M9.5 wires them in.
--
-- The enum is named `ChatDataSource` in Prisma (the unqualified
-- `DataSource` name is already taken by the `data_sources` table model).
-- The DB column is plain snake_case `data_source` to match the Phase 3.5
-- spec; mapping happens through @map in schema.prisma.

-- CreateEnum
CREATE TYPE "ChatDataSource" AS ENUM ('csv_upload', 'opensearch');

-- AlterTable
ALTER TABLE "chat_params"
    ADD COLUMN "data_source" "ChatDataSource" NOT NULL DEFAULT 'csv_upload',
    ADD COLUMN "media_types" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
