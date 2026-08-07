import z from "zod"

export const projectSchma = z.object({
    name: z.string(),
    repoUrl: z.string(),
    repoId: z.string().optional(),
    type: z.string(),
    framework: z.string().optional(),
    buildCommand: z.string().optional(),
    installCommand: z.string().optional(),
    startCommand: z.string().optional(),
    outputDirectory: z.string().optional(),
    rootDirectory: z.string().optional(),
    baseImage: z.string().optional(),
    slug: z.string().optional()
})

export const createProjectSchema = projectSchma.omit({
    repoId: true,
    slug: true
})

export const updateProjectSchema = projectSchma.omit({
    repoId: true,
    slug: true
})
