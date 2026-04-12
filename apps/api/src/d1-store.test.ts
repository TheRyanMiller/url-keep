import { describe, expect, it, vi } from "vitest";
import { D1Store } from "./d1-store";

describe("D1Store", () => {
  it("queries bookmark shares without requiring a table alias", async () => {
    const first = vi.fn().mockResolvedValue(null);
    const bind = vi.fn().mockReturnValue({ first });
    const prepare = vi.fn().mockReturnValue({ bind });
    const db = { prepare } as unknown as D1Database;
    const store = new D1Store(db);

    await store.getBookmarkShare("user-1", "bookmark-1");

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]?.[0]).not.toContain("b.share_id");
  });
});
