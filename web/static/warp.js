/* ============================================================
   Yapp.ai — WarpText heading (vanilla WebGL2 port)
   ------------------------------------------------------------
   The main "TEXT ↔ VOICE AI STUDIO" heading becomes a living
   warped-text element: text is rasterised to a 2D canvas, then
   a WebGL2 shader applies ambient noise warp, chromatic
   aberration, and mouse-reactive bulge/ripple.

   Originally an ogl + React component; ported to raw WebGL2 so
   it runs on the static FastAPI site with no build step.

   If WebGL2 is unavailable, the plain CSS <h1> stays visible.
   ============================================================ */
(function () {
  'use strict';

  /* ----------------------------------------------------------------
     2D TEXT RASTERISATION
     ---------------------------------------------------------------- */
  function getFontSize(value) {
    return typeof value === 'number' ? value + 'px' : value;
  }

  function measureLine(ctx, line, letterSpacing) {
    var chars = Array.from(line);
    var textWidth = chars.reduce(function (w, ch) { return w + ctx.measureText(ch).width; }, 0);
    return textWidth + Math.max(0, chars.length - 1) * letterSpacing;
  }

  function drawLine(ctx, line, x, y, letterSpacing) {
    var chars = Array.from(line);
    var cursor = x - measureLine(ctx, line, letterSpacing) / 2;
    chars.forEach(function (ch, i) {
      ctx.fillText(ch, cursor, y);
      cursor += ctx.measureText(ch).width + (i === chars.length - 1 ? 0 : letterSpacing);
    });
  }

  function buildTextCanvas(container, width, height, dpr, props) {
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));

    var ctx = canvas.getContext('2d');
    if (!ctx) return canvas;

    /* Measure via a hidden probe so CSS clamp() resolves. */
    var probe = document.createElement('span');
    probe.textContent = props.text;
    Object.assign(probe.style, {
      position: 'absolute', visibility: 'hidden', pointerEvents: 'none',
      whiteSpace: 'pre', inset: '0 auto auto 0',
      fontFamily: props.fontFamily,
      fontSize: getFontSize(props.fontSize),
      fontWeight: String(props.fontWeight),
      letterSpacing: getFontSize(props.letterSpacing),
      lineHeight: typeof props.lineHeight === 'number' ? String(props.lineHeight) : props.lineHeight
    });
    container.appendChild(probe);
    var computed = window.getComputedStyle(probe);
    var fontSizePx = parseFloat(computed.fontSize) || 96;
    var fontFamily = computed.fontFamily || 'sans-serif';
    var fontWeight = computed.fontWeight || String(props.fontWeight);
    var letterSpacing = computed.letterSpacing === 'normal' ? 0 : parseFloat(computed.letterSpacing) || 0;
    var lineHeight = parseFloat(computed.lineHeight);
    if (!Number.isFinite(lineHeight)) {
      lineHeight = fontSizePx * (typeof props.lineHeight === 'number' ? props.lineHeight : 0.92);
    }
    probe.remove();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = props.color;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    var lines = String(props.text || '').split('\n');
    var applyFont = function () { ctx.font = fontWeight + ' ' + fontSizePx + 'px ' + fontFamily; };
    applyFont();

    var maxWidth = width * 0.86;
    var maxHeight = height * 0.78;
    var widest = Math.max.apply(null, lines.map(function (l) { return measureLine(ctx, l, letterSpacing); }).concat([1]));
    var blockHeight = Math.max(lineHeight * lines.length, 1);
    var fit = Math.min(1, maxWidth / widest, maxHeight / blockHeight);

    if (fit < 1) {
      fontSizePx *= fit;
      letterSpacing *= fit;
      lineHeight *= fit;
      applyFont();
    }

    var startY = height / 2 - (lineHeight * (lines.length - 1)) / 2;
    lines.forEach(function (line, i) { drawLine(ctx, line, width / 2, startY + i * lineHeight, letterSpacing); });
    return canvas;
  }

  /* ----------------------------------------------------------------
     SHADERS (GLSL 300 es — WebGL2 only)
     ---------------------------------------------------------------- */
  var VERT = [
    '#version 300 es',
    'in vec2 position;',
    'out vec2 vUv;',
    'void main() {',
    '  vUv = position * 0.5 + 0.5;',
    '  gl_Position = vec4(position, 0.0, 1.0);',
    '}'
  ].join('\n');

  var FRAG = `
#version 300 es
precision highp float;

uniform sampler2D uTextTexture;
uniform vec2  uResolution;
uniform vec2  uPointer;
uniform float uPointerActive;
uniform float uTime;
uniform float uWarpStrength;
uniform float uWarpScale;
uniform float uSpeed;
uniform float uPointerInfluence;
uniform float uPointerStrength;
uniform float uRefraction;
uniform float uRipple;
uniform float uMotion;

in vec2 vUv;
out vec4 fragColor;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 4; i++) {
    value += amplitude * noise(p);
    p *= 2.02;
    amplitude *= 0.5;
  }
  return value;
}

vec4 sampleText(vec2 uv) {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
  return texture(uTextTexture, uv);
}

void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  float time  = uTime * uSpeed;
  float scale = max(uWarpScale, 0.001);

  vec2 drift = vec2(time * 0.055, -time * 0.045);
  float n1 = fbm(uv * scale * 3.1 + drift);
  float n2 = fbm((uv + 19.17) * scale * 3.4 - drift.yx);
  vec2 ambient = (vec2(n1, n2) - 0.5) * uWarpStrength * 0.045 * uMotion;

  vec2 pointerDelta = uv - uPointer;
  vec2 aspectDelta  = vec2(pointerDelta.x * aspect, pointerDelta.y);
  float dist   = length(aspectDelta);
  float radius = max(uPointerInfluence, 0.001);
  float t      = clamp(dist / radius, 0.0, 1.0);
  float lens   = smoothstep(radius, 0.0, dist) * uPointerActive;
  float bulge  = t * (1.0 - t) * (1.0 - t) * 6.75 * uPointerActive;
  vec2 dir = dist > 0.0001
    ? vec2(aspectDelta.x / aspect, aspectDelta.y) / dist
    : vec2(0.0);

  float rippleWave = sin(dist * 28.0 - time * 4.2) * 0.5 + 0.5;
  float rippleRing = (rippleWave - 0.5) * uRipple;
  vec2 pointerWarp = -dir * bulge * uPointerStrength * 0.045;
  pointerWarp += dir * rippleRing * bulge * uPointerStrength * 0.016;

  vec2 displaced  = uv + ambient + pointerWarp;
  vec2 splitDir   = ambient + pointerWarp;
  float splitLen  = length(splitDir);
  splitDir = splitLen > 0.00001 ? splitDir / splitLen : vec2(0.7071, 0.7071);
  vec2 split = splitDir * uRefraction * 0.16 * (0.35 + lens * 1.65);

  vec4 base = sampleText(displaced);
  float r = sampleText(displaced + split).r;
  float g = base.g;
  float b = sampleText(displaced - split).b;
  float a = max(max(sampleText(displaced + split).a, base.a), sampleText(displaced - split).a);

  vec3 color = vec3(r, g, b) + lens * base.a * 0.055;
  fragColor = vec4(color, a);
}
`;

  /* ----------------------------------------------------------------
     WEBGL2 HELPERS
     ---------------------------------------------------------------- */
  function compileShader(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('Shader: ' + log);
    }
    return sh;
  }

  function linkProgram(gl, vs, fs) {
    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      var log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error('Link: ' + log);
    }
    return prog;
  }

  /* ----------------------------------------------------------------
     THEME
     ---------------------------------------------------------------- */
  function textColor() {
    return document.documentElement.dataset.theme === 'dark' ? '#f8f5ff' : '#171a26';
  }

  /* ----------------------------------------------------------------
     ENGINE
     ---------------------------------------------------------------- */
  function createWarpText(container, opts) {
    opts = opts || {};

    var canvas = document.createElement('canvas');
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.style.pointerEvents = 'none';
    canvas.setAttribute('aria-hidden', 'true');
    container.appendChild(canvas);

    var gl = null;
    try {
      gl = canvas.getContext('webgl2', { alpha: true, antialias: true, premultipliedAlpha: false });
    } catch (_) { /* ignore */ }
    if (!gl) throw new Error('WebGL2 not supported');

    var dpr = Math.min(opts.dpr != null ? opts.dpr : (window.devicePixelRatio || 1), 2);
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    var prog = linkProgram(gl, compileShader(gl, gl.VERTEX_SHADER, VERT), compileShader(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.useProgram(prog);

    var U = {};
    ['uTextTexture', 'uResolution', 'uPointer', 'uPointerActive', 'uTime',
     'uWarpStrength', 'uWarpScale', 'uSpeed', 'uPointerInfluence',
     'uPointerStrength', 'uRefraction', 'uRipple', 'uMotion'
    ].forEach(function (n) { U[n] = gl.getUniformLocation(prog, n); });

    function s1f(n, v) { var l = U[n]; if (l) gl.uniform1f(l, v); }
    function s2f(n, a, b) { var l = U[n]; if (l) gl.uniform2f(l, a, b); }

    /* Fullscreen triangle (uv derived in vertex shader). */
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var posLoc = gl.getAttribLocation(prog, 'position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.clearColor(0, 0, 0, 0);

    /* Texture for the rasterised text. */
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    /* Mutable state. */
    var state = {
      text: opts.text || 'TEXT↔VOICE\nAI STUDIO',
      color: opts.color || textColor(),
      fontSize: opts.fontSize || 'clamp(2.4rem, 6vw, 4.4rem)',
      fontWeight: opts.fontWeight || 800,
      fontFamily: opts.fontFamily || "'Space Grotesk', sans-serif",
      letterSpacing: opts.letterSpacing || '-2.5px',
      lineHeight: opts.lineHeight || 0.92,
      warpStrength: opts.warpStrength != null ? opts.warpStrength : 0.08,
      warpScale: opts.warpScale != null ? opts.warpScale : 1.7,
      speed: opts.speed != null ? opts.speed : 0.55,
      pointerInfluence: opts.pointerInfluence != null ? opts.pointerInfluence : 0.42,
      pointerStrength: opts.pointerStrength != null ? opts.pointerStrength : 0.38,
      refraction: opts.refraction != null ? opts.refraction : 0.018,
      ripple: opts.ripple != null ? opts.ripple : 1
    };

    var pointer = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5, active: 0, activeTarget: 0 };
    var startTime = performance.now();
    var raf = 0, disposed = false, contextLost = false;
    var visible = true, pageVisible = !document.hidden;
    var rasterVersion = 0;

    /* ---- rasterise text → texture ---- */
    function rasterize() {
      var version = ++rasterVersion;
      var done = function () {
        if (disposed || contextLost || version !== rasterVersion) return;
        doRaster();
      };
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(done, done);
      } else {
        setTimeout(done, 100);
      }
    }

    function doRaster() {
      var rect = container.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      var textCanvas = buildTextCanvas(container, rect.width, rect.height, dpr, state);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, textCanvas);
      renderOnce();
    }

    function renderOnce() {
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    /* ---- resize ---- */
    function resize() {
      if (disposed || contextLost) return;
      var rect = container.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      var w = Math.max(1, Math.round(rect.width * dpr));
      var h = Math.max(1, Math.round(rect.height * dpr));
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
      s2f('uResolution', w, h);
      rasterize();
    }

    /* ---- pointer ---- */
    function onPointerMove(e) {
      if (e.pointerType === 'touch') return;
      var rect = container.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      pointer.tx = (e.clientX - rect.left) / rect.width;
      pointer.ty = 1 - (e.clientY - rect.top) / rect.height;
      var overHeading = e.clientX >= rect.left && e.clientX <= rect.right
                     && e.clientY >= rect.top && e.clientY <= rect.bottom;
      pointer.activeTarget = overHeading ? 1 : 0;
    }

    /* ---- visibility ---- */
    function onVisibility() {
      pageVisible = !document.hidden;
      if (pageVisible && visible && !raf) raf = requestAnimationFrame(loop);
      if (!pageVisible && raf) { cancelAnimationFrame(raf); raf = 0; }
    }

    /* ---- loop ---- */
    function loop(now) {
      if (disposed || contextLost) return;
      var elapsed = (now - startTime) * 0.001;

      var idleX = 0.5 + Math.sin(elapsed * 0.33) * 0.12;
      var idleY = 0.5 + Math.cos(elapsed * 0.27) * 0.1;
      var targetX = pointer.activeTarget > 0 ? pointer.tx : idleX;
      var targetY = pointer.activeTarget > 0 ? pointer.ty : idleY;
      var damping = pointer.activeTarget > 0 ? 0.12 : 0.035;

      pointer.x += (targetX - pointer.x) * damping;
      pointer.y += (targetY - pointer.y) * damping;
      pointer.active += ((pointer.activeTarget > 0 ? 1 : 0.18) - pointer.active) * 0.06;

      s2f('uPointer', pointer.x, pointer.y);
      s1f('uPointerActive', reduced ? pointer.active * 0.35 : pointer.active);
      s1f('uTime', reduced ? 0 : elapsed);

      renderOnce();
      raf = requestAnimationFrame(loop);
    }

    /* ---- context lost ---- */
    canvas.addEventListener('webglcontextlost', function (e) {
      e.preventDefault();
      contextLost = true;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
    }, false);

    /* ---- init uniforms ---- */
    s1f('uWarpStrength', state.warpStrength);
    s1f('uWarpScale', state.warpScale);
    s1f('uSpeed', state.speed);
    s1f('uPointerInfluence', state.pointerInfluence);
    s1f('uPointerStrength', state.pointerStrength);
    s1f('uRefraction', state.refraction);
    s1f('uRipple', state.ripple ? 1 : 0);
    s1f('uMotion', reduced ? 0 : 1);
    s2f('uPointer', 0.5, 0.5);
    s1f('uPointerActive', 0);
    s1f('uTime', 0);

    /* ---- observers ---- */
    var ro = new ResizeObserver(resize);
    ro.observe(container);

    var io = new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      if (visible && pageVisible && !raf) raf = requestAnimationFrame(loop);
      if (!visible && raf) { cancelAnimationFrame(raf); raf = 0; }
    }, { threshold: 0 });
    io.observe(container);

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);

    resize();

    /* ---- public API ---- */
    return {
      applyTheme: function () {
        state.color = textColor();
        rasterize();
      },
      destroy: function () {
        disposed = true;
        if (raf) cancelAnimationFrame(raf);
        ro.disconnect();
        io.disconnect();
        window.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('visibilitychange', onVisibility);
        try {
          gl.deleteTexture(tex);
          gl.deleteBuffer(buf);
          gl.getExtension('WEBGL_lose_context')?.loseContext();
        } catch (_) {}
        if (canvas.parentNode === container) container.removeChild(canvas);
      }
    };
  }

  /* ----------------------------------------------------------------
     AUTO-INIT
     ---------------------------------------------------------------- */
  window.WarpText = { create: createWarpText, instance: null };

  function boot() {
    var container = document.getElementById('warp-heading');
    if (!container) return;

    /* Ensure Space Grotesk is loaded before measuring. */
    var ready = (document.fonts && document.fonts.ready)
      ? document.fonts.ready.catch(function () {})
      : Promise.resolve();

    ready.then(function () {
      if (window.WarpText.instance) return;
      try {
        window.WarpText.instance = createWarpText(container, {
          text: 'TEXT↔VOICE\nAI STUDIO',
          color: textColor(),
          fontSize: 'clamp(2.4rem, 6vw, 4.4rem)',
          fontWeight: 800,
          fontFamily: "'Space Grotesk', sans-serif",
          letterSpacing: '-2.5px',
          lineHeight: 0.92,
          warpStrength: 0.08,
          warpScale: 1.7,
          speed: 0.55,
          pointerInfluence: 0.42,
          pointerStrength: 0.38,
          refraction: 0.018,
          ripple: 1,
          dpr: 2
        });
        document.body.classList.add('has-warp');
      } catch (e) {
        if (window.console) console.warn('WarpText disabled:', e && e.message ? e.message : e);
        /* h1 stays visible as plain text fallback. */
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
