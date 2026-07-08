/* @ds-bundle: {"format":4,"namespace":"DesignSystem_d5355e","components":[{"name":"Badge","sourcePath":"components/display/Badge.jsx"},{"name":"Card","sourcePath":"components/display/Card.jsx"},{"name":"Chip","sourcePath":"components/display/Chip.jsx"},{"name":"ProgressBar","sourcePath":"components/display/ProgressBar.jsx"},{"name":"ChatBubble","sourcePath":"components/editor/ChatBubble.jsx"},{"name":"FacetRailButton","sourcePath":"components/editor/FacetRailButton.jsx"},{"name":"MediaCard","sourcePath":"components/editor/MediaCard.jsx"},{"name":"ProposalCard","sourcePath":"components/editor/ProposalCard.jsx"},{"name":"TimelinePill","sourcePath":"components/editor/TimelinePill.jsx"},{"name":"Button","sourcePath":"components/forms/Button.jsx"},{"name":"IconButton","sourcePath":"components/forms/IconButton.jsx"},{"name":"SegmentedControl","sourcePath":"components/forms/SegmentedControl.jsx"},{"name":"Select","sourcePath":"components/forms/Select.jsx"},{"name":"Slider","sourcePath":"components/forms/Slider.jsx"},{"name":"Switch","sourcePath":"components/forms/Switch.jsx"},{"name":"TextField","sourcePath":"components/forms/TextField.jsx"}],"sourceHashes":{"components/display/Badge.jsx":"945d417894b4","components/display/Card.jsx":"0a49c008b484","components/display/Chip.jsx":"e8ce89e14157","components/display/ProgressBar.jsx":"389c60a837a5","components/editor/ChatBubble.jsx":"9fb2d4f5b482","components/editor/FacetRailButton.jsx":"0787738d5dbc","components/editor/MediaCard.jsx":"e7c8e7020f73","components/editor/ProposalCard.jsx":"a9b5577f85d1","components/editor/TimelinePill.jsx":"54dd80c4b997","components/forms/Button.jsx":"da1cbfaa0d8e","components/forms/IconButton.jsx":"acc85205377d","components/forms/SegmentedControl.jsx":"8ead5ca73ac1","components/forms/Select.jsx":"acfccc2a37f2","components/forms/Slider.jsx":"70f722a063d1","components/forms/Switch.jsx":"b6f070e782e5","components/forms/TextField.jsx":"000e9d209e3e"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.DesignSystem_d5355e = window.DesignSystem_d5355e || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/display/Badge.jsx
try { (() => {
/**
 * OpenScreen Badge — the small status pill. Optional leading dot.
 * tones: accent (default) · neutral · danger · warn. `soft` uses the
 * tinted fill (default); pass soft={false} for a bordered outline.
 */
function Badge({
  children,
  tone = 'accent',
  dot = false,
  soft = true,
  mono = true,
  style = {}
}) {
  const map = {
    accent: {
      fg: 'var(--accent)',
      bg: 'var(--accent-soft)',
      bd: 'var(--accent-border)',
      dot: 'var(--accent)'
    },
    neutral: {
      fg: 'var(--muted)',
      bg: 'var(--surface-2)',
      bd: 'var(--border)',
      dot: 'var(--muted)'
    },
    danger: {
      fg: 'var(--danger)',
      bg: 'var(--danger-soft)',
      bd: 'var(--danger)',
      dot: 'var(--danger)'
    },
    warn: {
      fg: 'var(--annotation)',
      bg: 'var(--annotation-wash)',
      bd: 'var(--annotation)',
      dot: 'var(--annotation)'
    }
  };
  const c = map[tone] || map.accent;
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      padding: dot ? '3px 9px 3px 7px' : '3px 9px',
      borderRadius: 9999,
      background: soft ? c.bg : 'transparent',
      border: soft ? 'none' : `1px solid ${c.bd}`,
      color: c.fg,
      fontFamily: mono ? 'var(--font-mono)' : 'var(--font-display)',
      fontSize: mono ? 9.5 : 11.5,
      fontWeight: 600,
      whiteSpace: 'nowrap',
      ...style
    }
  }, dot && /*#__PURE__*/React.createElement("span", {
    style: {
      width: 4,
      height: 4,
      borderRadius: '50%',
      background: c.dot
    }
  }), children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/Badge.jsx", error: String((e && e.message) || e) }); }

// components/display/Card.jsx
try { (() => {
/**
 * OpenScreen Card — the flat bordered surface container. `elevation`
 * "card" (resting) or "pop" (floating). `level` picks the fill surface.
 * Optional `title` renders a bordered header.
 */
function Card({
  children,
  title = null,
  headerRight = null,
  elevation = 'card',
  level = 1,
  radius = 14,
  padding = 14,
  style = {},
  bodyStyle = {}
}) {
  const fills = {
    0: 'var(--surface)',
    1: 'var(--surface-1)',
    2: 'var(--surface-2)'
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      border: '1px solid var(--border)',
      borderRadius: radius,
      background: fills[level] || fills[1],
      boxShadow: elevation === 'pop' ? 'var(--elev-pop)' : 'var(--elev-card)',
      overflow: 'hidden',
      ...style
    }
  }, title && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '11px 13px 10px',
      borderBottom: '1px solid var(--border-soft)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      fontWeight: 600,
      color: 'var(--fg)',
      letterSpacing: '-0.01em'
    }
  }, title), headerRight && /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 'auto'
    }
  }, headerRight)), /*#__PURE__*/React.createElement("div", {
    style: {
      padding,
      ...bodyStyle
    }
  }, children));
}
Object.assign(__ds_scope, { Card });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/Card.jsx", error: String((e && e.message) || e) }); }

// components/display/Chip.jsx
try { (() => {
/**
 * OpenScreen Chip — rounded action/filter pill with optional leading
 * icon. Used for the quick-action row above the composer. Hover gives
 * an accent wash + border.
 */
function Chip({
  children,
  icon = null,
  onClick,
  style = {}
}) {
  const [hover, setHover] = React.useState(false);
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: onClick,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      flex: '0 0 auto',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '6px 11px',
      borderRadius: 9999,
      background: hover ? 'var(--accent-wash)' : 'var(--surface-1)',
      border: `1px solid ${hover ? 'var(--accent-border)' : 'var(--border)'}`,
      color: hover ? 'var(--fg)' : 'var(--fg-2)',
      fontFamily: 'var(--font-display)',
      fontSize: 11.5,
      fontWeight: 500,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
      ...style
    }
  }, icon && /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--accent)',
      display: 'inline-flex'
    }
  }, icon), children);
}
Object.assign(__ds_scope, { Chip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/Chip.jsx", error: String((e && e.message) || e) }); }

// components/display/ProgressBar.jsx
try { (() => {
/**
 * OpenScreen ProgressBar — thin track with an emerald (or gradient)
 * fill. Used for the recipe step progress and generic determinate
 * progress. Height defaults to the 3px recipe bar.
 */
function ProgressBar({
  value = 0,
  height = 3,
  gradient = true,
  style = {}
}) {
  const pct = Math.max(0, Math.min(100, value));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      height,
      background: 'var(--surface-3)',
      position: 'relative',
      borderRadius: height / 2,
      overflow: 'hidden',
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: 0,
      top: 0,
      bottom: 0,
      width: `${pct}%`,
      background: gradient ? 'linear-gradient(90deg, var(--brand-lo), var(--brand))' : 'var(--accent)'
    }
  }));
}
Object.assign(__ds_scope, { ProgressBar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/ProgressBar.jsx", error: String((e && e.message) || e) }); }

// components/editor/ChatBubble.jsx
try { (() => {
/**
 * OpenScreen ChatBubble — a single agent-conversation row. Handles the
 * three roles: assistant (avatar + left bubble, meta header), user
 * (right, emerald-tinted), system (centered pill).
 */
function ChatBubble({
  role = 'assistant',
  author,
  time,
  children,
  avatar = null
}) {
  if (role === 'system') {
    return /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        justifyContent: 'center'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        maxWidth: '94%',
        padding: '6px 13px',
        borderRadius: 9999,
        background: 'var(--surface-1)',
        border: '1px solid var(--border-soft)',
        color: 'var(--muted)',
        fontSize: 11.5
      }
    }, children));
  }
  if (role === 'user') {
    return /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        justifyContent: 'flex-end'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        alignItems: 'flex-end',
        maxWidth: '86%'
      }
    }, (author || time) && /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
        padding: '0 2px'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11.5,
        fontWeight: 600,
        color: 'var(--fg)',
        letterSpacing: '-0.01em'
      }
    }, author), time && /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        color: 'var(--meta)'
      }
    }, time)), /*#__PURE__*/React.createElement("div", {
      style: {
        padding: '10px 14px',
        borderRadius: '15px 5px 15px 15px',
        background: 'var(--accent-soft)',
        border: '1px solid var(--accent-border)',
        color: 'var(--fg)',
        fontSize: 13,
        lineHeight: 1.55
      }
    }, children)));
  }
  // assistant
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10,
      alignItems: 'flex-start'
    }
  }, /*#__PURE__*/React.createElement("span", {
    "aria-hidden": "true",
    style: {
      width: 26,
      height: 26,
      borderRadius: 8,
      background: 'var(--surface-2)',
      border: '1px solid var(--border)',
      flexShrink: 0,
      marginTop: 2,
      display: 'grid',
      placeItems: 'center',
      color: 'var(--accent)'
    }
  }, avatar), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      minWidth: 0,
      maxWidth: '86%'
    }
  }, (author || time) && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 8,
      padding: '0 2px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11.5,
      fontWeight: 600,
      color: 'var(--fg)',
      letterSpacing: '-0.01em'
    }
  }, author), time && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 10,
      color: 'var(--meta)'
    }
  }, time)), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '11px 14px',
      borderRadius: '5px 15px 15px 15px',
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      color: 'var(--fg-2)',
      fontSize: 13,
      lineHeight: 1.55,
      boxShadow: 'var(--elev-card)'
    }
  }, children)));
}
Object.assign(__ds_scope, { ChatBubble });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/editor/ChatBubble.jsx", error: String((e && e.message) || e) }); }

// components/editor/FacetRailButton.jsx
try { (() => {
/**
 * OpenScreen FacetRailButton — an icon button in the vertical facet
 * rail beside the inspector. Active facet gets the emerald-soft fill.
 */
function FacetRailButton({
  active = false,
  title,
  onClick,
  children,
  style = {}
}) {
  const [hover, setHover] = React.useState(false);
  let color = active ? 'var(--accent)' : 'var(--muted)';
  let background = active ? 'var(--accent-soft)' : 'transparent';
  if (!active && hover) {
    color = 'var(--fg)';
    background = 'var(--surface-3)';
  }
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    title: title,
    "aria-label": title,
    "aria-pressed": active,
    onClick: onClick,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      width: 40,
      height: 40,
      display: 'grid',
      placeItems: 'center',
      border: 0,
      borderRadius: 11,
      background,
      color,
      cursor: 'pointer',
      ...style
    }
  }, children);
}
Object.assign(__ds_scope, { FacetRailButton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/editor/FacetRailButton.jsx", error: String((e && e.message) || e) }); }

// components/editor/MediaCard.jsx
try { (() => {
/**
 * OpenScreen MediaCard — a clip tile in the media library. Gradient
 * thumbnail with a film-strip glyph, a drag-handle affordance, and a
 * name/duration/size footer. Selected → 1.5px emerald border.
 */
function MediaCard({
  name,
  duration,
  size,
  from = '#10b981',
  to = '#0d986a',
  selected = false,
  draggable = true,
  onClick,
  onDragStart,
  onDragEnd,
  style = {}
}) {
  return /*#__PURE__*/React.createElement("button", {
    draggable: draggable,
    onClick: onClick,
    onDragStart: onDragStart,
    onDragEnd: onDragEnd,
    style: {
      display: 'flex',
      flexDirection: 'column',
      padding: 0,
      border: `1.5px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
      borderRadius: 12,
      background: 'var(--surface)',
      overflow: 'hidden',
      cursor: 'grab',
      textAlign: 'left',
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      height: 84,
      display: 'grid',
      placeItems: 'center',
      background: `linear-gradient(135deg, ${from}, ${to})`
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: "30",
    height: "30",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "rgba(255,255,255,0.85)",
    strokeWidth: "1.8",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("rect", {
    x: "2.5",
    y: "4",
    width: "19",
    height: "16",
    rx: "2"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M7 4v16M17 4v16M2.5 9h4.5M2.5 15h4.5M17 9h4.5M17 15h4.5"
  })), /*#__PURE__*/React.createElement("span", {
    "aria-hidden": "true",
    style: {
      position: 'absolute',
      top: 7,
      left: 7,
      width: 22,
      height: 22,
      display: 'grid',
      placeItems: 'center',
      borderRadius: 6,
      background: 'rgba(8,10,13,0.45)',
      backdropFilter: 'blur(6px)'
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: "12",
    height: "12",
    viewBox: "0 0 24 24",
    fill: "rgba(255,255,255,0.9)"
  }, /*#__PURE__*/React.createElement("circle", {
    cx: "9",
    cy: "6",
    r: "1.6"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "15",
    cy: "6",
    r: "1.6"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "9",
    cy: "12",
    r: "1.6"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "15",
    cy: "12",
    r: "1.6"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "9",
    cy: "18",
    r: "1.6"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "15",
    cy: "18",
    r: "1.6"
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 7,
      padding: '10px 12px'
    }
  }, selected && /*#__PURE__*/React.createElement("span", {
    style: {
      width: 6,
      height: 6,
      borderRadius: '50%',
      background: 'var(--accent)',
      flexShrink: 0
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      minWidth: 0,
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      fontWeight: 600,
      color: 'var(--fg)',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }
  }, name), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 10.5,
      color: 'var(--muted)'
    }
  }, duration), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 10.5,
      color: 'var(--meta)'
    }
  }, size)))));
}
Object.assign(__ds_scope, { MediaCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/editor/MediaCard.jsx", error: String((e && e.message) || e) }); }

// components/editor/ProposalCard.jsx
try { (() => {
/**
 * OpenScreen ProposalCard — the agent's "Proposed cuts" card: a header
 * with total + confidence badge, a list of time-range rows with striped
 * clip chips, an apply/review action row, and a rationale footnote.
 */
function ProposalCard({
  title = 'Proposed cuts',
  total,
  confidence = 'High confidence',
  items = [],
  rationale,
  applyLabel = 'Apply',
  onApply,
  onReview
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      border: '1px solid var(--border)',
      borderRadius: 14,
      background: 'var(--surface-1)',
      overflow: 'hidden',
      boxShadow: 'var(--elev-card)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '11px 13px 10px',
      borderBottom: '1px solid var(--border-soft)'
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: "13",
    height: "13",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    style: {
      color: 'var(--accent)'
    }
  }, /*#__PURE__*/React.createElement("path", {
    d: "M20 6 9 17l-5-5"
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      fontWeight: 600,
      color: 'var(--fg)',
      letterSpacing: '-0.01em'
    }
  }, title), total != null && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 10,
      color: 'var(--meta)'
    }
  }, "−", total), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 'auto',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      padding: '3px 8px',
      borderRadius: 9999,
      background: 'var(--accent-soft)',
      color: 'var(--accent)',
      fontFamily: 'var(--font-mono)',
      fontSize: 9.5,
      fontWeight: 600,
      border: '1px solid var(--accent-border)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 4,
      height: 4,
      borderRadius: '50%',
      background: 'var(--accent)'
    }
  }), confidence)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column'
    }
  }, items.map((it, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '8px 13px',
      borderBottom: '1px solid var(--border-soft)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    "aria-hidden": "true",
    style: {
      width: 16,
      height: 9,
      borderRadius: 2,
      flexShrink: 0,
      background: 'var(--accent-wash)',
      backgroundImage: 'repeating-linear-gradient(45deg, var(--accent-stripe) 0, var(--accent-stripe) 3px, transparent 3px, transparent 6px)'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 11.5,
      color: 'var(--fg)'
    }
  }, it.range), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 'auto',
      fontFamily: 'var(--font-mono)',
      fontSize: 10.5,
      color: 'var(--muted)'
    }
  }, "−", it.dur)))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '11px 13px',
      background: 'var(--surface)'
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onApply,
    style: {
      flex: 1,
      padding: '8px 12px',
      borderRadius: 10,
      border: '1px solid var(--accent)',
      background: 'var(--accent)',
      color: '#fff',
      fontSize: 12,
      fontWeight: 600,
      cursor: 'pointer',
      boxShadow: '0 2px 8px -3px var(--accent-soft)'
    }
  }, applyLabel), /*#__PURE__*/React.createElement("button", {
    onClick: onReview,
    style: {
      padding: '8px 12px',
      borderRadius: 10,
      border: '1px solid var(--border)',
      background: 'var(--surface-1)',
      color: 'var(--fg-2)',
      fontSize: 12,
      fontWeight: 500,
      cursor: 'pointer'
    }
  }, "Review each")), rationale && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 6,
      padding: '0 13px 12px'
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: "12",
    height: "12",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    style: {
      color: 'var(--meta)',
      flexShrink: 0,
      marginTop: 1
    }
  }, /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "10"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M12 16v-4"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M12 8h.01"
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10.5,
      color: 'var(--meta)',
      lineHeight: 1.45
    }
  }, rationale)));
}
Object.assign(__ds_scope, { ProposalCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/editor/ProposalCard.jsx", error: String((e && e.message) || e) }); }

// components/editor/TimelinePill.jsx
try { (() => {
/**
 * OpenScreen TimelinePill — a labelled marker on a timeline lane.
 * tone maps to the four lane accents. `fixedWidth` (tag mode) sizes to
 * content; otherwise it spans a range via left/width percentages.
 */
function TimelinePill({
  tone = 'accent',
  icon = null,
  children,
  leftPct = 0,
  widthPct = null,
  style = {}
}) {
  const map = {
    accent: {
      c: 'var(--accent)',
      w: 'var(--accent-soft)'
    },
    annotation: {
      c: 'var(--annotation)',
      w: 'var(--annotation-wash)'
    },
    speed: {
      c: 'var(--speed)',
      w: 'var(--speed-wash)'
    },
    danger: {
      c: 'var(--danger)',
      w: 'var(--danger-soft)'
    }
  };
  const t = map[tone] || map.accent;
  return /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      top: 1,
      left: `${leftPct}%`,
      width: widthPct == null ? 'max-content' : `${widthPct}%`,
      height: 22,
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      padding: '0 9px 0 7px',
      borderRadius: 6,
      border: `1.5px solid ${t.c}`,
      background: t.w,
      color: tone === 'danger' ? 'var(--danger)' : 'var(--fg)',
      fontSize: 11,
      fontWeight: 600,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      boxSizing: 'border-box',
      ...style
    }
  }, icon, children);
}
Object.assign(__ds_scope, { TimelinePill });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/editor/TimelinePill.jsx", error: String((e && e.message) || e) }); }

// components/forms/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * OpenScreen Button — the primary text action.
 * variants: primary (emerald fill) · secondary (surface + border) · ghost (transparent).
 * Icons are passed as children alongside a label, or use IconButton for icon-only.
 */
function Button({
  variant = 'primary',
  size = 'md',
  icon = null,
  iconRight = null,
  disabled = false,
  fullWidth = false,
  onClick,
  children,
  style = {},
  ...rest
}) {
  const sizes = {
    sm: {
      h: 28,
      px: 10,
      fs: 12,
      gap: 6,
      radius: 8
    },
    md: {
      h: 32,
      px: 14,
      fs: 13,
      gap: 7,
      radius: 9
    },
    lg: {
      h: 40,
      px: 18,
      fs: 14,
      gap: 9,
      radius: 12
    }
  };
  const s = sizes[size] || sizes.md;
  const variants = {
    primary: {
      background: 'var(--accent)',
      color: '#fff',
      border: '1px solid var(--accent)',
      boxShadow: '0 2px 10px -3px var(--accent-soft)'
    },
    secondary: {
      background: 'var(--surface-1)',
      color: 'var(--fg-2)',
      border: '1px solid var(--border)'
    },
    ghost: {
      background: 'transparent',
      color: 'var(--fg-2)',
      border: '1px solid transparent'
    }
  };
  const v = variants[variant] || variants.primary;
  const base = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: s.gap,
    height: s.h,
    padding: `0 ${s.px}px`,
    borderRadius: s.radius,
    fontFamily: 'var(--font-display)',
    fontSize: s.fs,
    fontWeight: 600,
    lineHeight: 1,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.45 : 1,
    whiteSpace: 'nowrap',
    ...v,
    ...style
  };
  const [hover, setHover] = React.useState(false);
  const hoverStyle = !disabled && hover ? variant === 'primary' ? {
    background: 'var(--brand-lo)'
  } : variant === 'secondary' ? {
    borderColor: 'var(--border-hi)',
    color: 'var(--fg)'
  } : {
    background: 'var(--surface-1)',
    borderColor: 'var(--border)'
  } : {};
  return /*#__PURE__*/React.createElement("button", _extends({
    type: "button",
    disabled: disabled,
    onClick: onClick,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      ...base,
      ...hoverStyle,
      width: fullWidth ? '100%' : undefined
    }
  }, rest), icon, children, iconRight);
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Button.jsx", error: String((e && e.message) || e) }); }

// components/forms/IconButton.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * OpenScreen IconButton — square, icon-only. The workhorse of toolbars,
 * the topbar, and floating chrome. Ghost by default; `active` gives the
 * emerald-soft selected look; `tone="danger"` for destructive.
 */
function IconButton({
  size = 32,
  active = false,
  tone = 'default',
  disabled = false,
  title,
  onClick,
  children,
  style = {},
  ...rest
}) {
  const [hover, setHover] = React.useState(false);
  const rest_ = {
    default: 'var(--muted)',
    danger: 'var(--muted)'
  }[tone];
  let color = active ? 'var(--accent)' : rest_;
  let background = active ? 'var(--accent-soft)' : 'transparent';
  if (!disabled && hover && !active) {
    if (tone === 'danger') {
      color = 'var(--danger)';
      background = 'var(--danger-soft)';
    } else {
      color = 'var(--fg)';
      background = 'var(--surface-2)';
    }
  }
  return /*#__PURE__*/React.createElement("button", _extends({
    type: "button",
    title: title,
    "aria-label": title,
    "aria-pressed": active || undefined,
    disabled: disabled,
    onClick: onClick,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      width: size,
      height: size,
      display: 'grid',
      placeItems: 'center',
      borderRadius: size <= 28 ? 6 : 9,
      border: 0,
      background,
      color,
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.4 : 1,
      flexShrink: 0,
      ...style
    }
  }, rest), children);
}
Object.assign(__ds_scope, { IconButton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/IconButton.jsx", error: String((e && e.message) || e) }); }

// components/forms/SegmentedControl.jsx
try { (() => {
/**
 * OpenScreen SegmentedControl — the pill-in-a-trough tab switcher.
 * Used for Media/Edit/Rec stage modes, Image/Color/Gradient background
 * tabs, Screen/Window source, etc. The active segment gets a raised
 * surface chip; inactive segments are muted text.
 */
function SegmentedControl({
  options = [],
  value,
  onChange,
  size = 'md',
  style = {}
}) {
  const s = size === 'sm' ? {
    pad: '6px 8px',
    fs: 11.5,
    trough: 2,
    radius: 8,
    inner: 6
  } : {
    pad: '7px 14px',
    fs: 12.5,
    trough: 3,
    radius: 11,
    inner: 8
  };
  return /*#__PURE__*/React.createElement("div", {
    role: "tablist",
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 2,
      padding: s.trough,
      background: 'var(--surface-1)',
      border: '1px solid var(--border)',
      borderRadius: s.radius,
      ...style
    }
  }, options.map(opt => {
    const val = typeof opt === 'string' ? opt : opt.value;
    const label = typeof opt === 'string' ? opt : opt.label;
    const active = val === value;
    return /*#__PURE__*/React.createElement("button", {
      key: val,
      role: "tab",
      "aria-selected": active,
      onClick: () => onChange && onChange(val),
      style: {
        padding: s.pad,
        border: 0,
        borderRadius: s.inner,
        cursor: 'pointer',
        fontFamily: 'var(--font-display)',
        fontSize: s.fs,
        fontWeight: 600,
        lineHeight: 1,
        background: active ? 'var(--surface-hi)' : 'transparent',
        color: active ? 'var(--fg-emphasis)' : 'var(--muted)',
        boxShadow: active ? 'var(--elev-card)' : 'none'
      }
    }, label);
  }));
}
Object.assign(__ds_scope, { SegmentedControl });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/SegmentedControl.jsx", error: String((e && e.message) || e) }); }

// components/forms/Select.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * OpenScreen Select — native dropdown styled to match. Used for
 * caption style, layout preset, transcript language, etc.
 */
function Select({
  options = [],
  value,
  onChange,
  fullWidth = true,
  style = {},
  ...rest
}) {
  return /*#__PURE__*/React.createElement("select", _extends({
    value: value,
    onChange: e => onChange && onChange(e.target.value),
    style: {
      width: fullWidth ? '100%' : undefined,
      height: 36,
      padding: '0 11px',
      borderRadius: 10,
      border: '1px solid var(--border)',
      background: 'var(--surface-2)',
      color: 'var(--fg-2)',
      fontFamily: 'var(--font-display)',
      fontSize: 12.5,
      fontWeight: 500,
      outline: 'none',
      cursor: 'pointer',
      ...style
    }
  }, rest), options.map(opt => {
    const val = typeof opt === 'string' ? opt : opt.value;
    const label = typeof opt === 'string' ? opt : opt.label;
    return /*#__PURE__*/React.createElement("option", {
      key: val,
      value: val
    }, label);
  }));
}
Object.assign(__ds_scope, { Select });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Select.jsx", error: String((e && e.message) || e) }); }

// components/forms/Slider.jsx
try { (() => {
/**
 * OpenScreen Slider — the labelled range control inside inspector cards.
 * Renders the whole card: label (left) + mono value in emerald (right)
 * above a filled range track. Pass `card={false}` for a bare track.
 */
function Slider({
  label,
  value = 0,
  min = 0,
  max = 100,
  step = 1,
  format,
  onChange,
  card = true,
  style = {}
}) {
  const pct = (value - min) / (max - min) * 100;
  const trackStyle = {
    width: '100%',
    display: 'block',
    backgroundImage: `linear-gradient(var(--accent),var(--accent)), linear-gradient(var(--surface-3),var(--surface-3))`,
    backgroundSize: `${pct}% 5px, 100% 5px`
  };
  const display = format ? format(value) : value;
  const input = /*#__PURE__*/React.createElement("input", {
    type: "range",
    min: min,
    max: max,
    step: step,
    value: value,
    onChange: e => onChange && onChange(Number(e.target.value)),
    style: trackStyle
  });
  if (!card) return input;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      border: '1px solid var(--border)',
      borderRadius: 12,
      background: 'var(--surface)',
      padding: '11px 13px',
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11.5,
      fontWeight: 500,
      color: 'var(--fg-2)'
    }
  }, label), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 11,
      color: 'var(--accent)',
      marginLeft: 'auto'
    }
  }, display)), input);
}
Object.assign(__ds_scope, { Slider });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Slider.jsx", error: String((e && e.message) || e) }); }

// components/forms/Switch.jsx
try { (() => {
/**
 * OpenScreen Switch — the pill toggle used in inspector setting rows
 * (Blur background, Mirror webcam, Shrink on zoom, Show cursor…).
 * Track fills emerald when on; knob slides right.
 */
function Switch({
  checked = false,
  onChange,
  disabled = false,
  style = {}
}) {
  const W = 38,
    H = 22,
    KNOB = 16,
    PAD = 3;
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    role: "switch",
    "aria-checked": checked,
    disabled: disabled,
    onClick: () => !disabled && onChange && onChange(!checked),
    style: {
      position: 'relative',
      width: W,
      height: H,
      flexShrink: 0,
      border: 0,
      borderRadius: 9999,
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1,
      background: checked ? 'var(--accent)' : 'var(--surface-3)',
      transition: 'background .18s var(--ease)',
      ...style
    }
  }, /*#__PURE__*/React.createElement("span", {
    "aria-hidden": "true",
    style: {
      position: 'absolute',
      top: PAD,
      left: checked ? W - KNOB - PAD : PAD,
      width: KNOB,
      height: KNOB,
      borderRadius: '50%',
      background: '#fff',
      boxShadow: '0 1px 3px rgba(0,0,0,0.35)',
      transition: 'left .18s var(--ease)'
    }
  }));
}
Object.assign(__ds_scope, { Switch });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Switch.jsx", error: String((e && e.message) || e) }); }

// components/forms/TextField.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * OpenScreen TextField — one primitive for both single-line inputs and
 * the multiline composer (same border/fill/radius vocabulary).
 * `multiline` swaps <input> for an auto-height <textarea>.
 * `leadingIcon` renders a search/glyph inside a bordered wrapper.
 */
function TextField({
  value,
  onChange,
  placeholder,
  multiline = false,
  leadingIcon = null,
  rows = 2,
  style = {},
  wrapStyle = {},
  ...rest
}) {
  const shared = {
    width: '100%',
    minWidth: 0,
    border: 0,
    background: 'transparent',
    fontFamily: 'var(--font-display)',
    fontSize: 13,
    lineHeight: 1.5,
    color: 'var(--fg)',
    outline: 'none',
    resize: 'none'
  };
  const control = multiline ? /*#__PURE__*/React.createElement("textarea", _extends({
    value: value,
    onChange: e => onChange && onChange(e.target.value),
    placeholder: placeholder,
    rows: rows,
    style: {
      ...shared,
      minHeight: 28,
      ...style
    }
  }, rest)) : /*#__PURE__*/React.createElement("input", _extends({
    value: value,
    onChange: e => onChange && onChange(e.target.value),
    placeholder: placeholder,
    style: {
      ...shared,
      ...style
    }
  }, rest));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: multiline ? 'flex-start' : 'center',
      gap: 10,
      padding: multiline ? '9px 11px' : '10px 14px',
      border: '1px solid var(--border)',
      borderRadius: multiline ? 14 : 10,
      background: 'var(--surface-1)',
      ...wrapStyle
    }
  }, leadingIcon, control);
}
Object.assign(__ds_scope, { TextField });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/TextField.jsx", error: String((e && e.message) || e) }); }

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.Card = __ds_scope.Card;

__ds_ns.Chip = __ds_scope.Chip;

__ds_ns.ProgressBar = __ds_scope.ProgressBar;

__ds_ns.ChatBubble = __ds_scope.ChatBubble;

__ds_ns.FacetRailButton = __ds_scope.FacetRailButton;

__ds_ns.MediaCard = __ds_scope.MediaCard;

__ds_ns.ProposalCard = __ds_scope.ProposalCard;

__ds_ns.TimelinePill = __ds_scope.TimelinePill;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.IconButton = __ds_scope.IconButton;

__ds_ns.SegmentedControl = __ds_scope.SegmentedControl;

__ds_ns.Select = __ds_scope.Select;

__ds_ns.Slider = __ds_scope.Slider;

__ds_ns.Switch = __ds_scope.Switch;

__ds_ns.TextField = __ds_scope.TextField;

})();
