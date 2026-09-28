import { z } from "zod"

export const editDiagramTool = {
    description: `Edit the current diagram by ID-based operations (update/add/delete cells).

Operations:
- update: Replace an existing cell by its id. Provide cell_id and complete new_xml.
- add: Add a new cell. Provide cell_id (new unique id) and new_xml.
- delete: Remove a cell. Cascade is automatic: children AND edges (source/target) are auto-deleted. Only specify ONE cell_id.

For update/add, new_xml must be a complete mxCell element including mxGeometry.

⚠️ JSON ESCAPING: Every " inside new_xml MUST be escaped as \\". Example: id=\\"5\\" value=\\"Label\\"

Example - Add a rectangle:
{"operations": [{"operation": "add", "cell_id": "rect-1", "new_xml": "<mxCell id=\\"rect-1\\" value=\\"Hello\\" style=\\"rounded=0;\\" vertex=\\"1\\" parent=\\"1\\"><mxGeometry x=\\"100\\" y=\\"100\\" width=\\"120\\" height=\\"60\\" as=\\"geometry\\"/></mxCell>"}]}

Example - Delete container (children & edges auto-deleted):
{"operations": [{"operation": "delete", "cell_id": "2"}]}`,
    inputSchema: z.object({
        operations: z
            .array(
                z.object({
                    operation: z
                        .enum(["update", "add", "delete"])
                        .describe(
                            "Operation to perform: add, update, or delete",
                        ),
                    cell_id: z
                        .string()
                        .describe(
                            "The id of the mxCell. Must match the id attribute in new_xml.",
                        ),
                    new_xml: z
                        .string()
                        .optional()
                        .describe(
                            "Complete mxCell XML element (required for update/add)",
                        ),
                }),
            )
            .describe("Array of operations to apply"),
    }),
}
