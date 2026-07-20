declare module "markdown-it-task-lists" {
    import type MarkdownIt from "markdown-it";

    interface TaskListsOptions {
        enabled?: boolean;
        label?: boolean;
        labelAfter?: boolean;
    }

    const plugin: MarkdownIt.PluginWithOptions<TaskListsOptions>;
    export default plugin;
}
