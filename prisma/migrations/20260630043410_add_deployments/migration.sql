/*
  Warnings:

  - Added the required column `repoUrl` to the `Project` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "ProjectType" AS ENUM ('STATIC', 'BACKEND');

-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('QUEUED', 'BUILDING', 'SUCCESS', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "buildCommand" TEXT,
ADD COLUMN     "framework" TEXT,
ADD COLUMN     "installCommand" TEXT,
ADD COLUMN     "outDirectory" TEXT,
ADD COLUMN     "repoId" INTEGER,
ADD COLUMN     "repoUrl" TEXT NOT NULL,
ADD COLUMN     "rootDirectory" TEXT DEFAULT '/',
ADD COLUMN     "startCommand" TEXT,
ADD COLUMN     "type" "ProjectType" NOT NULL DEFAULT 'STATIC';

-- CreateTable
CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" "DeploymentStatus" NOT NULL DEFAULT 'QUEUED',
    "imageUri" TEXT,
    "staticS3Key" TEXT,
    "url" TEXT,
    "ecsServiceArm" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentLog" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "line" TEXT NOT NULL,
    "stream" TEXT NOT NULL DEFAULT 'stdout',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeploymentLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnvVar" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnvVar_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentLog" ADD CONSTRAINT "DeploymentLog_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvVar" ADD CONSTRAINT "EnvVar_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
