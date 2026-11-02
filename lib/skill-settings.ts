import { DefaultPackageManager, loadSkills, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ResolvedResource } from "@earendil-works/pi-coding-agent";
import { dirname, relative, resolve } from "node:path";
import type { InstalledSkill } from "./skills.js";

/** Use Pi's native filters, so disabled skills survive reload and remain discoverable. */
export async function skillSettings(cwd: string, agentDir: string, projectTrusted: boolean, active: InstalledSkill[]) {
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted });
  const errors = () => {
    const failures = settings.drainErrors();
    if (failures.length) throw new Error(failures.map((item) => item.error.message).join("; "));
  };
  errors();
  const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
  // Browsing installed skills must never install a missing package.
  const resources = (await manager.resolve(async () => "skip")).skills;
  const entries = new Map<string, InstalledSkill>(active.map((item) => [item.filePath, { ...item, enabled: true }]));
  const owners = new Map<string, ResolvedResource>();
  for (const resource of resources) {
    const loaded = loadSkills({ cwd, agentDir, skillPaths: [resource.path], includeDefaults: false });
    for (const skill of loaded.skills) {
      owners.set(skill.filePath, resource);
      entries.set(skill.filePath, { ...skill, installed: true, enabled: resource.enabled,
        scope: resource.metadata.scope === "project" ? "project" : "global",
        source: resource.metadata.origin === "package" ? resource.metadata.source : "Local file" });
    }
  }
  return {
    installed: () => [...entries.values()].sort((a, b) => a.name.localeCompare(b.name)),
    async setEnabled(item: InstalledSkill, enabled: boolean) {
      const resource = owners.get(item.filePath);
      if (!resource || resource.metadata.scope === "temporary") throw new Error("This skill is controlled by command-line options and cannot be changed here.");
      const project = resource.metadata.scope === "project";
      if (project && !projectTrusted) throw new Error("Changing project skills requires a trusted project.");
      await settings.reload();
      errors();
      const current = project ? settings.getProjectSettings() : settings.getGlobalSettings();
      const update = (paths: string[], pattern: string, baseDir: string) => [...paths.filter((path) =>
        !/^[+-]/.test(path) || resolve(baseDir, path.slice(1)) !== resolve(baseDir, pattern)), `${enabled ? "+" : "-"}${pattern}`];
      if (resource.metadata.origin === "package") {
        const packages = structuredClone(current.packages || []);
        const index = packages.findIndex((pkg) => (typeof pkg === "string" ? pkg : pkg.source) === resource.metadata.source);
        if (index < 0) throw new Error("The skill package settings changed. Reopen /skills.");
        const entry = packages[index]!;
        const pkg = typeof entry === "string" ? { source: entry } : entry;
        const baseDir = resource.metadata.baseDir || dirname(resource.path);
        const pattern = relative(baseDir, resource.path);
        // An empty package filter means 'load none', not 'load all except this entry'.
        pkg.skills = update(pkg.skills?.length === 0 ? ["!**"] : pkg.skills || [], pattern, baseDir);
        packages[index] = pkg;
        if (project) settings.setProjectPackages(packages); else settings.setPackages(packages);
      } else {
        const paths = update(current.skills || [], resource.path, resource.metadata.baseDir || agentDir);
        if (project) settings.setProjectSkillPaths(paths); else settings.setSkillPaths(paths);
      }
      await settings.flush();
      errors();
      for (const [path, owner] of owners) if (owner === resource) entries.get(path)!.enabled = enabled;
    },
  };
}
