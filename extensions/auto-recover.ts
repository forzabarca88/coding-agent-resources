/**
 * Auto-Recover Extension
 *
 * Detects when an agent turn ends with tool calls that weren't executed
 * and automatically sends a user message prompting the model to continue.
 *
 * The check runs at agent_end — the boundary where the agent loop finishes
 * and control returns to the user.
 *
 * Place in ~/.pi/agent/extensions/ for global use, or .pi/extensions/ for
 * project-local.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_CONSECUTIVE = 3;

const RECOVERY_MESSAGE =
        "You sent an invalid tool call, continue more carefully.";

export default function (pi: ExtensionAPI) {
        let consecutiveRecoveries = 0;

        pi.on("agent_end", async (_event, ctx) => {
                const branch = ctx.sessionManager.getBranch();

                // Find the last assistant message in this agent run
                let lastAssistantEntry = null;
                for (let i = branch.length - 1; i >= 0; i--) {
                        const entry = branch[i];
                        if (
                                entry.type === "message" &&
                                (entry.message as { role?: string })?.role === "assistant"
                        ) {
                                lastAssistantEntry = entry;
                                break;
                        }
                }

                if (!lastAssistantEntry) {
                        consecutiveRecoveries = 0;
                        return;
                }

                const msg = lastAssistantEntry.message as { content?: unknown };
                const content = msg.content;
                if (!Array.isArray(content)) {
                        consecutiveRecoveries = 0;
                        return;
                }

                // Find toolResult entries after the last assistant message
                const lastAssistantIndex = branch.indexOf(lastAssistantEntry);
                const executedIds = new Set<string>();

                for (let i = lastAssistantIndex + 1; i < branch.length; i++) {
                        const entry = branch[i];
                        if (
                                entry.type === "message" &&
                                ((entry.message as { role?: string })?.role === "toolResult" ||
                                        (entry.message as { role?: string })?.role === "tool_result")
                        ) {
                                const toolCallId =
                                        (entry as { toolCallId?: string }).toolCallId ??
                                        ((entry.message as { toolCallId?: string }) as any)?.toolCallId ??
                                        ((entry.message as { tool_use_id?: string }) as any)?.tool_use_id;
                                if (toolCallId) {
                                        executedIds.add(toolCallId);
                                }
                        }
                }

                // Collect unexecuted tool calls from parsed toolCall parts
                let totalUnexecuted = 0;
                const toolNames: string[] = [];

                for (const part of content) {
                        if (!part || typeof part !== "object" || !("type" in part)) continue;
                        const type = (part as { type: string }).type;

                        if (type === "toolCall") {
                                const block = part as { id?: string; name?: string };
                                if (block.id && typeof block.id === "string" && !executedIds.has(block.id)) {
                                        totalUnexecuted++;
                                        toolNames.push(block.name || "unknown");
                                }
                        }

                        if (type === "text" || type === "thinking") {
                                // Check for XML tool call tags leaked as plain text or inside thinking blocks
                                const textContent =
                                        type === "thinking"
                                                ? ((part as { thinking?: string }).thinking || "")
                                                : ((part as { text?: string }).text || "");
                                const text = textContent.toString();
                                const xmlToolCalls = text.match(/<\w+[^>]*\/?>/g) || [];
                                for (const tag of xmlToolCalls) {
                                        if (tag.match(/<(?:function|tool|tool_call)\b/i)) {
                                                totalUnexecuted++;
                                                const nameMatch = tag.match(/<(?:function|tool)\s*=\s*["']?([^"'\s>]+)["']?/i);
                                                toolNames.push(nameMatch ? nameMatch[1] : "unknown");
                                        }
                                }
                        }
                }

                // --- No issues found ---
                if (totalUnexecuted === 0) {
                        consecutiveRecoveries = 0;
                        return;
                }

                // --- Build reason string ---
                const names = [...new Set(toolNames)].join(", ");
                const reason = `${totalUnexecuted} tool call(s) (${names}) not executed`;

                // --- Trigger auto-recovery ---
                consecutiveRecoveries++;

                if (consecutiveRecoveries >= MAX_CONSECUTIVE) {
                        consecutiveRecoveries = 0;
                        if (ctx.hasUI) {
                                ctx.ui.notify(
                                        `Auto-recovery disabled after ${MAX_CONSECUTIVE} consecutive failures`,
                                        "error",
                                );
                        }
                        return;
                }

                if (ctx.hasUI) {
                        ctx.ui.notify(
                                `${reason}. Auto-recovering (${consecutiveRecoveries}/${MAX_CONSECUTIVE})`,
                                "warning",
                        );
                }

                pi.sendUserMessage(RECOVERY_MESSAGE, { deliverAs: "followUp" });
        });
}
