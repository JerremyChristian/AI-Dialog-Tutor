"use client";

import { useEffect, useMemo, useState } from "react";
import type { CoverageStatus, LessonNode, LessonState } from "../lib/lesson-state";

type Props = {
  lessonState: LessonState;
  lessonActive: boolean;
  navigationPending: boolean;
  onNavigate: (node: LessonNode) => void;
};

const STATUS_PRESENTATION: Record<CoverageStatus, { icon: string; label: string }> = {
  "not-started": { icon: "○", label: "Not started" },
  teaching: { icon: "▶", label: "Current" },
  partial: { icon: "◐", label: "Partially covered" },
  taught: { icon: "✓", label: "Covered" },
  skipped: { icon: "↷", label: "Skipped" },
};

export function LessonRoadmap({
  lessonState,
  lessonActive,
  navigationPending,
  onNavigate,
}: Props) {
  const treeKey = useMemo(
    () => `${lessonState.rootNodeIds.join("|")}:${Object.keys(lessonState.nodes).sort().join("|")}`,
    [lessonState.nodes, lessonState.rootNodeIds],
  );
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(new Set());
  const activePathNodeIds = useMemo(() => {
    const activePath = new Set<string>();
    if (!lessonActive || !lessonState.currentNodeId) return activePath;
    let nodeId: string | null = lessonState.currentNodeId;
    while (nodeId) {
      activePath.add(nodeId);
      nodeId = lessonState.nodes[nodeId]?.parentId ?? null;
    }
    return activePath;
  }, [lessonActive, lessonState.currentNodeId, lessonState.nodes]);

  useEffect(() => {
    const initiallyExpanded = new Set<string>();
    for (const rootId of lessonState.rootNodeIds) {
      if (lessonState.nodes[rootId]?.childrenIds.length) initiallyExpanded.add(rootId);
    }
    setExpandedNodeIds(initiallyExpanded);
  }, [treeKey]);

  useEffect(() => {
    const currentId = lessonState.currentNodeId;
    if (!currentId) return;
    setExpandedNodeIds((current) => {
      const next = new Set(current);
      let parentId = lessonState.nodes[currentId]?.parentId ?? null;
      while (parentId) {
        next.add(parentId);
        parentId = lessonState.nodes[parentId]?.parentId ?? null;
      }
      return next;
    });
  }, [lessonState.currentNodeId, lessonState.nodes]);

  const teachableNodes = useMemo(
    () => Object.values(lessonState.nodes).filter(isTeachableNode),
    [lessonState.nodes],
  );
  const covered = teachableNodes.filter((node) => node.status === "taught").length;
  const partial = teachableNodes.filter((node) => node.status === "partial").length;
  const skipped = teachableNodes.filter((node) => node.status === "skipped").length;
  const summary = teachableNodes.length
    ? `${covered} of ${teachableNodes.length} covered${partial ? ` · ${partial} partial` : ""}${skipped ? ` · ${skipped} skipped` : ""}`
    : "No lesson outline available";

  const toggleExpanded = (nodeId: string) => {
    setExpandedNodeIds((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };

  const renderNode = (nodeId: string, depth: number): React.ReactNode => {
    const node = lessonState.nodes[nodeId];
    if (!node) return null;
    const structural = node.childrenIds.length > 0;
    const teachable = isTeachableNode(node);
    const expanded = expandedNodeIds.has(node.id);
    const current = lessonActive && node.id === lessonState.currentNodeId;
    const activeBranch = structural && activePathNodeIds.has(node.id);
    const displayStatus = !lessonActive && node.status === "teaching"
      ? "not-started"
      : node.status;
    const status = STATUS_PRESENTATION[displayStatus];
    const statusLabel = activeBranch
      ? node.status === "teaching"
        ? "Current branch"
        : `${status.label} · Active branch`
      : status.label;
    const rowLabel = current
      ? `Current concept: ${node.title}`
      : structural
        ? `${expanded ? "Collapse" : "Expand"} ${node.title}`
        : teachable
          ? `Go to ${node.title}. ${statusLabel}`
          : `Topic: ${node.title}. ${statusLabel}`;

    return (
      <li key={node.id}>
        <div
          className={`roadmap-row roadmap-${displayStatus}${activeBranch ? " roadmap-active-branch" : ""}${current ? " roadmap-current" : ""}`}
          style={{ "--roadmap-depth": Math.min(depth, 4) } as React.CSSProperties}
        >
          <span className="roadmap-status-icon" aria-hidden="true">{status.icon}</span>
          <button
            type="button"
            className="roadmap-node-button"
            aria-label={rowLabel}
            aria-current={current ? "step" : undefined}
            aria-expanded={structural ? expanded : undefined}
            disabled={teachable && navigationPending}
            aria-disabled={!structural && (!teachable || !lessonActive || current) ? true : undefined}
            onClick={() => {
              if (structural) toggleExpanded(node.id);
              else if (teachable && lessonActive && !current) onNavigate(node);
            }}
          >
            <span className="roadmap-node-title">{node.title}</span>
            <span className="roadmap-status-label">{statusLabel}</span>
          </button>
          {structural && (
            <span className="roadmap-expand-icon" aria-hidden="true">{expanded ? "−" : "+"}</span>
          )}
        </div>
        {structural && expanded && (
          <ol>{node.childrenIds.map((childId) => renderNode(childId, depth + 1))}</ol>
        )}
      </li>
    );
  };

  return (
    <details className="lesson-roadmap" open={!lessonActive}>
      <summary>
        <span>Lesson progress</span>
        <small>{summary}</small>
      </summary>
      <div className="roadmap-body">
        {navigationPending && <p className="roadmap-pending" role="status">Moving to selected concept…</p>}
        {lessonState.rootNodeIds.length ? (
          <ol className="roadmap-tree">
            {lessonState.rootNodeIds.map((rootId) => renderNode(rootId, 0))}
          </ol>
        ) : (
          <p className="roadmap-empty">The lesson outline will appear when the source is ready.</p>
        )}
      </div>
    </details>
  );
}

function isTeachableNode(node: LessonNode) {
  return node.childrenIds.length === 0 && Boolean(node.teaching);
}
