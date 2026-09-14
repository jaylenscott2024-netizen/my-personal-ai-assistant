export default { name: "plugin-c", version: "1.0.0", description: "Test plugin C, deliberately under a directory with a space in its name" };

export const tools = [
  {
    name: "plugin_c_tool",
    description: "A tool from plugin C.",
    version: "1.0.0",
    inputSchema: { safeParse: (v) => ({ success: true, data: v }) },
    jsonSchema: { type: "object", properties: {} },
    requiredPermissions: [],
    requiresApproval: false,
    async execute() {
      return { output: { from: "plugin-c" } };
    },
  },
];
