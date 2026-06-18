/*
  Warnings:

  - You are about to drop the column `accessToken` on the `User` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[githubInstallationId]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "User" DROP COLUMN "accessToken",
ADD COLUMN     "githubInstallationId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_githubInstallationId_key" ON "User"("githubInstallationId");
