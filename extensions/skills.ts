import { getAgentDir, VERSION } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Input, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { installedSkills, installSkill, previewInstalledSkill, previewSkill, searchSkills, skillText } from "../lib/skills.js";
import { createSkillsScreen } from "../ui/skills-screen.js";
import { createHeader } from "../ui/chrome.js";
import { createUiTheme } from "../ui/theme.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "../lib/errors.js";

export default function skillsCommand(pi: ExtensionAPI) {
  pi.registerCommand("skills", {
    description: "Browse installed skills, search skills.sh, and install a skill",
    handler: async (args, ctx) => {
      const query = args.trim().slice(0, 200);
      if (ctx.mode !== "tui") {
        try {
          const items = query ? await searchSkills(query, { signal: ctx.signal }) : installedSkills(ctx);
          const output = [`Skills${query ? ` — ${skillText(query)}` : " installed"}`, ...items.map((item) => `${skillText(item.name)} — ${skillText(item.description || item.source)}`)].join("\n");
          if (ctx.hasUI) ctx.ui.notify(output, "info"); else console.error(output);
        } catch (error) { if (ctx.hasUI) ctx.ui.notify(errorMessage(error), "error"); else console.error(errorMessage(error)); }
        return;
      }
      const agentDir = getAgentDir();
      const reload = await ctx.ui.custom((tui, _theme, _keys, done) => {
        const theme = createUiTheme();
        const measure = { CURSOR_MARKER, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi };
        const header = createHeader({ mode: "regular" }, theme, measure, {
          version: VERSION, getModel: () => ctx.model, getThinkingLevel: () => pi.getThinkingLevel(), getCwd: () => ctx.cwd,
        });
        const footer = tui.children.at(-1);
        return createSkillsScreen({ tui, theme, measure, Input, done, initialQuery: query,
          renderHeader: (width) => header.render(width), renderFooter: (width) => footer?.render(width),
          projectTrusted: ctx.isProjectTrusted(), projectPath: join(ctx.cwd, ".pi", "skills"), globalPath: join(agentDir, "skills"),
          services: {
            installed: () => installedSkills(ctx),
            search: (value, signal) => searchSkills(value, { signal }),
            preview: (item, signal) => previewSkill(item, { signal }),
            previewInstalled: previewInstalledSkill,
            install: (item, scope, signal) => installSkill(item, { scope, cwd: ctx.cwd, agentDir, projectTrusted: ctx.isProjectTrusted(), signal }),
          },
        });
      }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 } });
      if (reload) {
        ctx.ui.notify("Skill installed. Reloading skills…", "info");
        await ctx.reload();
        return;
      }
    },
  });
}
