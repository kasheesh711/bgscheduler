(function defineLineOaResolverCandidateUtils(root) {
  function normalize(value) {
    return (value || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}.]+/gu, "");
  }

  function rectFrom(value) {
    if (!value) return null;
    const top = Number(value.top);
    const left = Number(value.left);
    const width = Number(value.width);
    const height = Number(value.height);
    if (![top, left, width, height].every(Number.isFinite)) return null;
    return {
      top,
      left,
      width,
      height,
      right: Number.isFinite(Number(value.right)) ? Number(value.right) : left + width,
      bottom: Number.isFinite(Number(value.bottom)) ? Number(value.bottom) : top + height,
    };
  }

  function overlapLength(startA, endA, startB, endB) {
    return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
  }

  function overlapRatio(a, b, axis) {
    const rectA = rectFrom(a);
    const rectB = rectFrom(b);
    if (!rectA || !rectB) return 0;
    if (axis === "x") {
      const overlap = overlapLength(rectA.left, rectA.right, rectB.left, rectB.right);
      return overlap / Math.max(1, Math.min(rectA.width, rectB.width));
    }
    const overlap = overlapLength(rectA.top, rectA.bottom, rectB.top, rectB.bottom);
    return overlap / Math.max(1, Math.min(rectA.height, rectB.height));
  }

  function isSameVisualRow(a, b) {
    const rectA = rectFrom(a?.rect || a);
    const rectB = rectFrom(b?.rect || b);
    if (!rectA || !rectB) return false;
    const centerYDistance = Math.abs((rectA.top + rectA.height / 2) - (rectB.top + rectB.height / 2));
    const centerClose = centerYDistance <= Math.max(10, Math.min(rectA.height, rectB.height) * 0.45);
    return (
      overlapRatio(rectA, rectB, "y") >= 0.55
      && overlapRatio(rectA, rectB, "x") >= 0.25
    ) || (
      centerClose
      && overlapRatio(rectA, rectB, "x") >= 0.55
    );
  }

  function hitQuality(hit) {
    const rect = rectFrom(hit?.rect);
    if (!rect) return 0;
    return (hit.lineChatUrl ? 1_000_000 : 0)
      + Math.min(rect.width, 900) * 100
      + Math.min(rect.height, 180) * 10
      + Math.min(String(hit.text || "").length, 240);
  }

  function candidateFingerprint(candidate) {
    const rect = rectFrom(candidate?.rect);
    const textKey = normalize(candidate?.text || "").slice(0, 180);
    if (!rect) return `${textKey}|no-rect|${candidate?.lineChatUrl || ""}`;
    return [
      textKey,
      Math.round(rect.top / 8) * 8,
      Math.round(rect.left / 12) * 12,
      Math.round(rect.height / 4) * 4,
      candidate?.lineChatUrl || "",
    ].join("|");
  }

  function rectIsInSearchColumn(rect, inputRect) {
    const candidateRect = rectFrom(rect);
    const searchRect = rectFrom(inputRect);
    if (!candidateRect || !searchRect) return true;
    const paddedLeft = searchRect.left - 32;
    const paddedRight = searchRect.right + Math.max(96, searchRect.width * 0.8);
    return candidateRect.right >= paddedLeft
      && candidateRect.left <= paddedRight
      && candidateRect.bottom >= searchRect.bottom - 24;
  }

  function uniqueValues(values) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
      const normalizedValue = normalize(value);
      if (!normalizedValue || seen.has(normalizedValue)) continue;
      seen.add(normalizedValue);
      result.push(normalizedValue);
    }
    return result;
  }

  function rowSearchCodeSet(row) {
    return new Set(uniqueValues([
      row?.searchCode,
      ...(Array.isArray(row?.searchCodes) ? row.searchCodes : []),
    ]));
  }

  function normalizedParentGroup(row) {
    const parent = normalize(row?.parentName || "");
    return parent === "missingparent" ? "" : parent;
  }

  function rowsAreRelated(a, b) {
    const parentA = normalizedParentGroup(a);
    const parentB = normalizedParentGroup(b);
    if (parentA && parentA === parentB) return true;

    const codesA = rowSearchCodeSet(a);
    const codesB = rowSearchCodeSet(b);
    for (const code of codesA) {
      if (codesB.has(code)) return true;
    }
    return false;
  }

  function classifyRepeatedSameChat(recentCaptures, nextCapture, options) {
    const windowSize = Number(options?.windowSize || 3);
    const recent = [
      ...(Array.isArray(recentCaptures) ? recentCaptures : []),
      nextCapture,
    ].slice(-windowSize);
    const lineUserId = nextCapture?.lineUserId || null;
    if (!lineUserId || recent.length < windowSize) {
      return { suspect: false, recent, lineUserId };
    }

    const allSameLineUser = recent.every((capture) => capture?.lineUserId === lineUserId);
    const distinctStudents = new Set(recent.map((capture) => capture?.studentKey).filter(Boolean));
    const allRelated = recent.every((capture) => rowsAreRelated(nextCapture, capture));
    return {
      suspect: allSameLineUser && distinctStudents.size >= windowSize && !allRelated,
      recent,
      lineUserId,
    };
  }

  function collapseVisualRows(rawHits, options) {
    const limit = Number(options?.limit || 5);
    const hits = (Array.isArray(rawHits) ? rawHits : [])
      .map((hit) => ({ ...hit, rect: rectFrom(hit?.rect) }))
      .filter((hit) => hit.rect && hit.text)
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    const groups = [];

    for (const hit of hits) {
      const group = groups.find((candidateGroup) => candidateGroup.some((existing) => isSameVisualRow(existing, hit)));
      if (group) {
        group.push(hit);
      } else {
        groups.push([hit]);
      }
    }

    return groups
      .map((group) => {
        const representative = [...group].sort((a, b) => hitQuality(b) - hitQuality(a))[0];
        const longestText = [...group].sort((a, b) => String(b.text || "").length - String(a.text || "").length)[0]?.text;
        const candidate = {
          ...representative,
          text: longestText || representative.text,
          rawDomHitCount: group.length,
        };
        return {
          ...candidate,
          fingerprint: candidateFingerprint(candidate),
        };
      })
      .sort((a, b) => a.rect.top - b.rect.top)
      .slice(0, limit);
  }

  const api = {
    normalize,
    collapseVisualRows,
    candidateFingerprint,
    rectIsInSearchColumn,
    isSameVisualRow,
    classifyRepeatedSameChat,
    rowsAreRelated,
    rowSearchCodeSet,
  };

  root.LineOaResolverCandidateUtils = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
