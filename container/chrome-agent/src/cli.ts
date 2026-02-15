#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { ChromeAgent } from "./index.js";

const CDP_URL = process.env["CHROME_CDP_URL"] ?? "http://localhost:9222";

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "help" || command === "--help") {
    console.log(`Usage: chrome-agent <command> [args]

Commands:
  navigate <url>              Navigate to a URL
  snapshot                    Print accessibility snapshot with refs
  click <ref>                 Click element (e.g. @e1)
  type <ref> <text>           Type text into element
  select <ref> <value...>     Select option(s) in a select element
  screenshot [--full-page] [--output path] [--format png|jpeg]
  tabs list                   List open tabs
  tabs new [url]              Open a new tab
  tabs close [id]             Close a tab
  cookies export              Export cookies as JSON
  cookies import <file>       Import cookies from JSON file
  back                        Navigate back
  forward                     Navigate forward
  reload                      Reload page

Environment:
  CHROME_CDP_URL              CDP endpoint (default: http://localhost:9222)`);
    process.exit(0);
  }

  const agent = await ChromeAgent.connect(CDP_URL);

  try {
    switch (command) {
      case "navigate": {
        const url = args[0];
        if (!url) {
          console.error("Usage: chrome-agent navigate <url>");
          process.exit(1);
        }
        await agent.navigate(url);
        console.log(`Navigated to ${url}`);
        break;
      }

      case "snapshot": {
        const text = await agent.snapshot();
        console.log(text);
        break;
      }

      case "click": {
        const ref = args[0];
        if (!ref) {
          console.error("Usage: chrome-agent click <ref>");
          process.exit(1);
        }
        // Need a snapshot first to build ref map
        await agent.snapshot();
        await agent.click(ref);
        console.log(`Clicked ${ref}`);
        break;
      }

      case "type": {
        const ref = args[0];
        const text = args.slice(1).join(" ");
        if (!ref || !text) {
          console.error("Usage: chrome-agent type <ref> <text>");
          process.exit(1);
        }
        await agent.snapshot();
        await agent.type(ref, text);
        console.log(`Typed into ${ref}`);
        break;
      }

      case "select": {
        const ref = args[0];
        const values = args.slice(1);
        if (!ref || !values.length) {
          console.error("Usage: chrome-agent select <ref> <value...>");
          process.exit(1);
        }
        await agent.snapshot();
        await agent.select(ref, values);
        console.log(`Selected in ${ref}`);
        break;
      }

      case "screenshot": {
        let fullPage = false;
        let output = "screenshot.png";
        let format: "png" | "jpeg" = "png";
        for (let i = 0; i < args.length; i++) {
          if (args[i] === "--full-page") {
            fullPage = true;
          } else if (args[i] === "--output" && args[i + 1]) {
            output = args[++i]!;
          } else if (args[i] === "--format" && args[i + 1]) {
            format = args[++i] as "png" | "jpeg";
          }
        }
        const buf = await agent.screenshot({ fullPage, format });
        writeFileSync(output, buf);
        console.log(`Screenshot saved to ${output}`);
        break;
      }

      case "tabs": {
        const sub = args[0];
        if (sub === "list" || !sub) {
          const tabs = agent.listTabs();
          for (const t of tabs) {
            console.log(`${t.tabId}  ${t.url}  ${t.title}`);
          }
          if (!tabs.length) {
            console.log("(no tracked tabs)");
          }
        } else if (sub === "new") {
          const id = await agent.newTab(args[1]);
          console.log(`New tab: ${id}`);
        } else if (sub === "close") {
          await agent.closeTab(args[1]);
          console.log("Tab closed");
        } else {
          console.error(`Unknown tabs subcommand: ${sub}`);
          process.exit(1);
        }
        break;
      }

      case "cookies": {
        const sub = args[0];
        if (sub === "export") {
          const json = await agent.exportCookies();
          console.log(json);
        } else if (sub === "import") {
          const file = args[1];
          if (!file) {
            console.error("Usage: chrome-agent cookies import <file>");
            process.exit(1);
          }
          const json = readFileSync(file, "utf-8");
          await agent.importCookies(json);
          console.log("Cookies imported");
        } else {
          console.error("Usage: chrome-agent cookies export|import");
          process.exit(1);
        }
        break;
      }

      case "back":
        await agent.back();
        console.log("Navigated back");
        break;

      case "forward":
        await agent.forward();
        console.log("Navigated forward");
        break;

      case "reload":
        await agent.reload();
        console.log("Page reloaded");
        break;

      default:
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }
  } finally {
    await agent.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
