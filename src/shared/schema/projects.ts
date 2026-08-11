import z from "zod"

export const projectSchma = z.object({
    name: z.string(),
    repoUrl: z.string(),
    repoId: z.string().optional(),
    type: z.string(),
    framework: z.string().nullable().optional(),
    buildCommand: z.string().nullable().optional(),
    installCommand: z.string().nullable().optional(),
    startCommand: z.string().nullable().optional(),
    outputDirectory: z.string().nullable().optional(),
    rootDirectory: z.string().nullable().optional(),
    baseImage: z.string().nullable().optional(),
    slug: z.string().nullable().optional(),
    branch: z.string().nullable().optional(),
    envVars: z.array(z.object({ key: z.string(), value: z.string() })).optional()
})

export const createProjectSchema = projectSchma.omit({
    repoId: true,
    slug: true
})

export const updateProjectSchema = projectSchma.omit({
    repoId: true,
    slug: true
})
