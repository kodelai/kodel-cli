import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };

const program = new Command();
program
  .name("kodel")
  .description("Spec-driven pipelines inside your coding agent")
  .version(pkg.version);
program.parse();
