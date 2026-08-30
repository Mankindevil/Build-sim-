export interface RouteAssemblyTask {
  readonly taskId: string;
  readonly cableInstanceId: string;
  readonly dependsOnTaskIds: readonly string[];
  readonly blockedByEntityIds: readonly string[];
}

export function orderRouteAssembly(tasks: readonly RouteAssemblyTask[]): readonly RouteAssemblyTask[] {
  const byId = new Map<string, RouteAssemblyTask>();
  for (const task of tasks) {
    if (!task.taskId || byId.has(task.taskId)) throw new TypeError("route assembly task identity is invalid");
    byId.set(task.taskId, structuredClone(task));
  }
  const result: RouteAssemblyTask[] = [];
  const completed = new Set<string>();
  while (result.length < tasks.length) {
    const ready = [...byId.values()]
      .filter((task) => !completed.has(task.taskId) && task.dependsOnTaskIds.every((id) => completed.has(id)))
      .sort((left, right) => left.taskId.localeCompare(right.taskId));
    if (ready.length === 0) {
      const missing = tasks.flatMap((task) => task.dependsOnTaskIds).find((id) => !byId.has(id));
      throw new TypeError(missing ? "route assembly task dependency is missing" : "route assembly task dependencies contain a cycle");
    }
    for (const task of ready) { completed.add(task.taskId); result.push(task); }
  }
  return result;
}
