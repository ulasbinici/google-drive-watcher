import { describe, expect, it } from "vitest";
import {
  classifyChange,
  foldersTouchedByChildren,
  isInsideSelection,
  isRedundantParentUpdate,
  shouldReportChange,
  type FileSnapshot,
} from "./change-processor.js";

const base: FileSnapshot = {
  id: "file",
  name: "report.pdf",
  parentIds: ["child"],
};

describe("classifyChange", () => {
  it("classifies lifecycle changes", () => {
    expect(classifyChange(base, undefined, false)).toBe("created");
    expect(classifyChange(base, base, false)).toBe("updated");
    expect(
      classifyChange({ ...base, parentIds: ["other"] }, base, false),
    ).toBe("moved");
    expect(classifyChange(undefined, base, true)).toBe("deleted");
    expect(classifyChange({ ...base, trashed: true }, base, false)).toBe(
      "deleted",
    );
  });

  it("does not treat reordered parent IDs as a move", () => {
    expect(
      classifyChange(
        { ...base, parentIds: ["a", "b"] },
        { ...base, parentIds: ["b", "a"] },
        false,
      ),
    ).toBe("updated");
  });
});

describe("isRedundantParentUpdate", () => {
  const parent: FileSnapshot = {
    id: "parent",
    name: "Dev files",
    mimeType: "application/vnd.google-apps.folder",
    parentIds: ["games"],
  };

  it("drops a folder edit when a child change names that folder", () => {
    const touched = foldersTouchedByChildren([
      { file: { parents: ["parent"] } },
    ]);
    expect(
      isRedundantParentUpdate("parent", "updated", parent, parent, touched),
    ).toBe(true);
  });

  it("keeps a rename and a folder edit that has no child change", () => {
    const touched = foldersTouchedByChildren([
      { file: { parents: ["parent"] } },
    ]);
    expect(
      isRedundantParentUpdate(
        "parent",
        "updated",
        { ...parent, name: "Design files" },
        parent,
        touched,
      ),
    ).toBe(false);
    expect(
      isRedundantParentUpdate("parent", "updated", parent, parent, new Set()),
    ).toBe(false);
    expect(
      isRedundantParentUpdate("parent", "created", parent, undefined, touched),
    ).toBe(false);
  });
});

describe("shouldReportChange", () => {
  const file: FileSnapshot = {
    id: "file",
    name: "background_normal.png",
    parentIds: ["folder"],
    modifiedTime: "2026-10-13T18:23:00Z",
  };

  it("drops the removed echo that follows a trash", () => {
    expect(shouldReportChange("deleted", true, undefined, undefined)).toBe(false);
    expect(shouldReportChange("deleted", true, file, undefined)).toBe(true);
    expect(shouldReportChange("deleted", false, file, { ...file, trashed: true })).toBe(true);
  });

  it("drops an update that changes nothing", () => {
    expect(shouldReportChange("updated", false, file, { ...file })).toBe(false);
    expect(
      shouldReportChange("updated", false, file, {
        ...file,
        modifiedTime: "2026-10-13T18:30:00Z",
      }),
    ).toBe(true);
  });

  it("keeps the first time a file is seen", () => {
    expect(shouldReportChange("created", false, undefined, file)).toBe(true);
  });
});

describe("isInsideSelection", () => {
  const parents = new Map([
    ["child", ["nested"]],
    ["nested", ["selected"]],
    ["selected", ["root"]],
  ]);

  it("matches recursive descendants and the selected folder itself", () => {
    expect(isInsideSelection("file", ["child"], "selected", parents)).toBe(
      true,
    );
    expect(isInsideSelection("selected", ["root"], "selected", parents)).toBe(
      true,
    );
  });

  it("rejects unrelated and cyclic ancestry", () => {
    const cyclic = new Map([
      ["a", ["b"]],
      ["b", ["a"]],
    ]);
    expect(isInsideSelection("file", ["other"], "selected", parents)).toBe(
      false,
    );
    expect(isInsideSelection("file", ["a"], "selected", cyclic)).toBe(false);
  });
});
