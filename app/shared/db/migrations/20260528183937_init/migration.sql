-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'analyst', 'viewer');

-- CreateEnum
CREATE TYPE "ChatStatus" AS ENUM ('active', 'completed', 'archived');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('user', 'assistant', 'system');

-- CreateEnum
CREATE TYPE "DataSourceType" AS ENUM ('meltwater', 'opoint', 'webz', 'twitter', 'infovision', 'custom');

-- CreateEnum
CREATE TYPE "MCPStatus" AS ENUM ('active', 'inactive', 'error');

-- CreateEnum
CREATE TYPE "LLMProvider" AS ENUM ('claude', 'gpt', 'ollama', 'perplexity');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "display_name" VARCHAR(100) NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'analyst',
    "preferences" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(255) NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "ip_address" INET,
    "user_agent" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chats" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "agent_type" VARCHAR(50) NOT NULL,
    "title" VARCHAR(255),
    "status" "ChatStatus" NOT NULL DEFAULT 'active',
    "context" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "chats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "role" "MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agents" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "type" VARCHAR(50) NOT NULL,
    "description" TEXT NOT NULL,
    "capabilities" JSONB NOT NULL DEFAULT '[]',
    "icon" VARCHAR(50),
    "color" VARCHAR(7),
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_logs" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "action" VARCHAR(50) NOT NULL,
    "input" JSONB NOT NULL DEFAULT '{}',
    "output" JSONB NOT NULL DEFAULT '{}',
    "duration_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_sources" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "source_type" "DataSourceType" NOT NULL,
    "display_name" VARCHAR(100) NOT NULL,
    "api_key_encrypted" TEXT NOT NULL,
    "endpoint_url" VARCHAR(500),
    "config" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_tested_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_connections" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "source_name" VARCHAR(100) NOT NULL,
    "server_url" VARCHAR(500) NOT NULL,
    "token_encrypted" TEXT NOT NULL,
    "status" "MCPStatus" NOT NULL DEFAULT 'inactive',
    "last_verified_at" TIMESTAMPTZ,
    "available_tools" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_configs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "LLMProvider" NOT NULL,
    "model_name" VARCHAR(100) NOT NULL,
    "api_key_encrypted" TEXT,
    "max_tokens" INTEGER NOT NULL DEFAULT 4096,
    "temperature" DECIMAL(3,2) NOT NULL DEFAULT 0.3,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skills" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT NOT NULL,
    "type" VARCHAR(50) NOT NULL,
    "handler_config" JSONB NOT NULL DEFAULT '{}',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_skills" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "skill_id" UUID NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "added_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_skills_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "users_is_active_idx" ON "users"("is_active");

-- CreateIndex
CREATE INDEX "sessions_user_id_is_active_idx" ON "sessions"("user_id", "is_active");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE INDEX "chats_user_id_status_idx" ON "chats"("user_id", "status");

-- CreateIndex
CREATE INDEX "chats_created_at_idx" ON "chats"("created_at");

-- CreateIndex
CREATE INDEX "messages_chat_id_created_at_idx" ON "messages"("chat_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "agents_name_key" ON "agents"("name");

-- CreateIndex
CREATE UNIQUE INDEX "agents_type_key" ON "agents"("type");

-- CreateIndex
CREATE INDEX "agent_logs_agent_id_created_at_idx" ON "agent_logs"("agent_id", "created_at");

-- CreateIndex
CREATE INDEX "data_sources_user_id_idx" ON "data_sources"("user_id");

-- CreateIndex
CREATE INDEX "mcp_connections_user_id_idx" ON "mcp_connections"("user_id");

-- CreateIndex
CREATE INDEX "llm_configs_user_id_idx" ON "llm_configs"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "skills_name_key" ON "skills"("name");

-- CreateIndex
CREATE UNIQUE INDEX "user_skills_user_id_skill_id_key" ON "user_skills"("user_id", "skill_id");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chats" ADD CONSTRAINT "chats_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_logs" ADD CONSTRAINT "agent_logs_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_sources" ADD CONSTRAINT "data_sources_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "llm_configs" ADD CONSTRAINT "llm_configs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_skills" ADD CONSTRAINT "user_skills_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_skills" ADD CONSTRAINT "user_skills_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;
