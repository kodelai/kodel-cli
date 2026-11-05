import { describe, expect, test } from "bun:test";
import type { CallOptions, TaskFilter } from "@kodel-ai/pipeline-core";
import { MemoryTaskAdapter, taskAdapterContract } from "../src";

const orderCase = (cases: ReturnType<typeof taskAdapterContract>) => {
  const found = cases.find((c) => c.name.includes("most important first, then oldest first"));
  if (!found) throw new Error("the conformance suite has no case about the order of a list");
  return found;
};

describe("task_g4jy_adapter_contract_checks_list_order", () => {
  test("task_g4jy_adapter_contract_checks_list_order: the memory adapter passes the case", async () => {
    const cases = taskAdapterContract(() => ({ adapter: new MemoryTaskAdapter() }));
    await orderCase(cases).run();
  });

  test("task_g4jy_adapter_contract_checks_list_order: an adapter that lists newest first is caught", async () => {
    class Reversed extends MemoryTaskAdapter {
      override async list(filter: TaskFilter, o: CallOptions) {
        const answer = await super.list(filter, o);
        return { ...answer, tasks: [...answer.tasks].reverse() };
      }
    }
    const cases = taskAdapterContract(() => ({ adapter: new Reversed() }));
    await expect(orderCase(cases).run()).rejects.toThrow(/comes before/);
  });
});
