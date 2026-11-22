const SHARES = Object.freeze({ recent: 30, memory: 20, situation: 10 });
const DROP_ORDER = Object.keys(SHARES);

export function planLayerQuotas({ parts, systemChars, measureRequest, requestCap, recentView, topicView }) {
  let result = { ...parts };
  const dropped = new Set();
  let roundsDropped = 0;
  let topicsDropped = 0;
  const capFor = (name) => Math.floor(systemChars * SHARES[name] / 100);
  const sizeOf = (value) => (value || '').trim().length;
  const fits = (candidate) => {
    const measured = measureRequest(candidate);
    return measured.system <= systemChars && measured.request <= requestCap;
  };
  let topics;
  function views(name) {
    const view = name === 'recent' ? recentView : name === 'memory' ? (topics ??= topicView() ?? false) : null;
    const count = name === 'recent' ? view?.roundCount : view?.topicCount;
    return { view, count: Number.isSafeInteger(count) ? Math.min(Math.max(0, count), 100) : 0 };
  }

  function reduce(name, minimum, fitsBudget) {
    if (!result[name]) return minimum;
    const fitsLayer = (text) => sizeOf(text) <= capFor(name);
    if (fitsLayer(result[name]) && fitsBudget(result)) return minimum;
    const { view, count } = views(name);
    if (view?.text === parts[name]) {
      for (let n = minimum + 1; n <= count; n += 1) {
        let text;
        try { text = view.renderFrom(n); } catch { break; }
        if (typeof text !== 'string') break;
        if (!fitsLayer(text)) continue;
        const candidate = { ...result, [name]: text };
        if (!fitsBudget(candidate)) continue;
        result = candidate;
        dropped.add(name);
        return n;
      }
    }
    result[name] = '';
    dropped.add(name);
    return count;
  }

  // Enforce individual shares before pooling unused room. When the combined
  // budget is still exceeded, try smaller units before discarding a block.
  const anySize = () => true;
  roundsDropped = reduce('recent', 0, anySize);
  topicsDropped = reduce('memory', 0, anySize);
  reduce('situation', 0, anySize);

  if (!fits(result)) {
    roundsDropped = reduce('recent', roundsDropped, fits);
    topicsDropped = reduce('memory', topicsDropped, fits);
    reduce('situation', 0, fits);
    if (!fits(result) && result.taskReferences.length) {
      result.taskReferences = [];
      dropped.add('taskReferences');
    }
  }
  return {
    parts: result,
    roundsDropped,
    topicsDropped,
    dropped: [...DROP_ORDER, 'taskReferences'].filter((name) => dropped.has(name)),
  };
}
