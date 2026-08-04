/* ============================================================
   Yapp.ai — Ferrofluid background (vanilla WebGL port)
   ------------------------------------------------------------
   The "liquid metal" shader behind the glass. Originally an ogl +
   React component; ported to raw WebGL1 so it runs on the static
   FastAPI site with no build step / no dependencies.

   It auto-initializes a <canvas id="ferro"> on page load and
   exposes window.Ferrofluid.create / .instance so the theme toggle
   can swap the palette. If WebGL is missing or fails to compile,
   the CSS aurora (.bg-orbs) stays as a graceful fallback.

   Controls (mirrors the React component's props):
     colors, speed, scale, turbulence, fluidity, rimWidth,
     sharpness, shimmer, glow, flowDirection, opacity,
     mouseInteraction, mouseStrength, mouseRadius, mouseDampening
   ============================================================ */
(function () {
  'use strict';

  var MAX_COLORS = 8;

  function hexToRGB(hex) {
    var c = String(hex || '#ffffff').replace('#', '').padEnd(6, '0');
    return [
      parseInt(c.slice(0, 2), 16) / 255,
      parseInt(c.slice(2, 4), 16) / 255,
      parseInt(c.slice(4, 6), 16) / 255
    ];
  }

  function prepColors(input) {
    var base = (input && input.length ? input : ['#4F46E5', '#06B6D4', '#E0F2FE']).slice(0, MAX_COLORS);
    var count = base.length;
    var arr = [], avg = [0, 0, 0];
    for (var i = 0; i < MAX_COLORS; i++) arr.push(hexToRGB(base[Math.min(i, base.length - 1)]));
    for (var j = 0; j < count; j++) { avg[0] += arr[j][0]; avg[1] += arr[j][1]; avg[2] += arr[j][2]; }
    avg[0] /= count; avg[1] /= count; avg[2] /= count;
    return { arr: arr, count: count, avg: avg };
  }

  function flowVec(d) {
    switch (d) {
      case 'up': return [0, 1];
      case 'left': return [-1, 0];
      case 'right': return [1, 0];
      default: return [0, -1];
    }
  }

  /* Fullscreen triangle. vUv is derived from position so we don't
     need a second attribute buffer. */
  var VERT = [
    'precision highp float;',
    'attribute vec2 position;',
    'varying vec2 vUv;',
    'void main() {',
    '  vUv = position * 0.5 + 0.5;',
    '  gl_Position = vec4(position, 0.0, 1.0);',
    '}'
  ].join('\n');

  /* Same shader as the React component — untouched, just embedded. */
  var FRAG = `
precision highp float;

uniform vec3  iResolution;
uniform vec2  iMouse;
uniform float iTime;

uniform vec3  uColor0;
uniform vec3  uColor1;
uniform vec3  uColor2;
uniform vec3  uColor3;
uniform vec3  uColor4;
uniform vec3  uColor5;
uniform vec3  uColor6;
uniform vec3  uColor7;
uniform int   uColorCount;

uniform vec3  uMouseColor;
uniform vec2  uFlow;
uniform float uSpeed;
uniform float uScale;
uniform float uTurbulence;
uniform float uFluidity;
uniform float uRimWidth;
uniform float uSharpness;
uniform float uShimmer;
uniform float uGlow;
uniform float uOpacity;
uniform float uMouseEnabled;
uniform float uMouseStrength;
uniform float uMouseRadius;

varying vec2 vUv;

#define PI 3.14159265

vec3 palette(float h) {
  int count = uColorCount;
  if (count < 1) count = 1;
  int idx = int(floor(clamp(h, 0.0, 0.999999) * float(count)));
  if (idx <= 0) return uColor0;
  if (idx == 1) return uColor1;
  if (idx == 2) return uColor2;
  if (idx == 3) return uColor3;
  if (idx == 4) return uColor4;
  if (idx == 5) return uColor5;
  if (idx == 6) return uColor6;
  return uColor7;
}

float hash(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float smin(float a, float b, float k) {
  float r = exp2(-a / k) + exp2(-b / k);
  return -k * log2(r);
}

float sinlerp(float a, float b, float w) {
  return mix(a, b, (sin(w * PI - PI / 2.0) + 1.0) / 2.0);
}

float vn(vec2 p, float s, float seed) {
  vec2 cellp = floor(p / s);
  vec2 relp = mod(p, s);
  float g1 = hash(vec3(cellp, seed));
  float g2 = hash(vec3(cellp.x + 1.0, cellp.y, seed));
  float g3 = hash(vec3(cellp.x + 1.0, cellp.y + 1.0, seed));
  float g4 = hash(vec3(cellp.x, cellp.y + 1.0, seed));
  float bx = sinlerp(g1, g2, relp.x / s);
  float tx = sinlerp(g4, g3, relp.x / s);
  return sinlerp(bx, tx, relp.y / s);
}

float dbn(vec2 p, float s, float seed) {
  float o = s / 2.0;
  float n0 = vn(p, s, seed);
  float n1 = vn(p + vec2(o, o), s, seed + 0.1);
  float n2 = vn(p + vec2(-o, o), s, seed + 0.2);
  float n3 = vn(p + vec2(o, -o), s, seed + 0.3);
  float n4 = vn(p + vec2(-o, -o), s, seed + 0.4);
  return (2.0 * n0 + 1.5 * n1 + 1.25 * n2 + 1.125 * n3 + n4) / 7.0;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  float ref = 700.0 / max(uScale, 0.05);
  vec2 p = fragCoord / iResolution.y * ref;

  float spd = 200.0 * uSpeed;
  float t = iTime;

  vec2 dir = uFlow;
  vec2 perp = vec2(-dir.y, dir.x);

  float distort1 = vn(p + perp * (t * spd), 60.0, 10.0) * 50.0 * uTurbulence;
  float distort2 = vn(p - perp * (t * spd), 120.0, 15.0) * 100.0 * uTurbulence;

  float peaks = dbn(p + distort1 + dir * (t * spd * 0.5), 40.0, 1.0);
  float peaks2 = dbn(p + distort2 - dir * (t * spd * 0.5), 40.0, 0.0);

  float mapeaks = smin(peaks, peaks2, max(uFluidity, 0.001));

  float mGlow = 0.0;
  if (uMouseEnabled > 0.5) {
    vec2 mp = iMouse / iResolution.y * ref;
    float md = length(p - mp) / ref;
    float rr = max(uMouseRadius, 0.02);
    mGlow = exp(-md * md / (rr * rr)) * uMouseStrength;
  }

  float band = (uRimWidth - abs((mapeaks - 0.4) * 2.0)) * 5.0;
  float ltn = clamp(band - vn(p + dir * (t * spd * 0.5), 60.0, 12.0) * uShimmer, 0.0, 1.0);
  ltn = pow(ltn, uSharpness) * uGlow;
  ltn *= clamp(1.0 - mGlow, 0.0, 1.0);

  float h = clamp(0.5 + (peaks - peaks2) * 0.8, 0.0, 1.0);
  vec3 col = palette(h);

  vec3 outc = col * ltn;
  float a = clamp(max(outc.r, max(outc.g, outc.b)), 0.0, 1.0);
  fragColor = vec4(outc, a * uOpacity);
}

void main() {
  vec4 color;
  mainImage(color, vUv * iResolution.xy);
  gl_FragColor = color;
}
`;

  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('Shader compile error: ' + log);
    }
    return sh;
  }

  function link(gl, vs, fs) {
    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      var log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error('Program link error: ' + log);
    }
    return prog;
  }

  /* Theme-aware palette: white-hot liquid on dark, brand colors on light
     (pure white would vanish against the light glass background). */
  function themeFor() {
    var dark = document.documentElement.dataset.theme === 'dark';
    return dark
      ? { colors: ['#ffffff', '#ffffff', '#ffffff'], glow: 2 }
      : { colors: ['#5b8cff', '#8b5cf6', '#ec4899', '#3fd6a4'], glow: 1.15 };
  }

  function createFerrofluid(canvas, opts) {
    opts = opts || {};
    var gl = canvas.getContext('webgl', { alpha: true, antialias: true })
      || canvas.getContext('experimental-webgl', { alpha: true, antialias: true });
    if (!gl) throw new Error('WebGL not supported');

    var dpr = Math.min(opts.dpr != null ? opts.dpr : (window.devicePixelRatio || 1), 2);
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var running = !opts.paused && !reduced;

    var prog = link(gl, compile(gl, gl.VERTEX_SHADER, VERT), compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.useProgram(prog);

    var UNIFORMS = [
      'iResolution', 'iMouse', 'iTime',
      'uColor0', 'uColor1', 'uColor2', 'uColor3', 'uColor4', 'uColor5', 'uColor6', 'uColor7', 'uColorCount',
      'uMouseColor', 'uFlow', 'uSpeed', 'uScale', 'uTurbulence', 'uFluidity', 'uRimWidth', 'uSharpness',
      'uShimmer', 'uGlow', 'uOpacity', 'uMouseEnabled', 'uMouseStrength', 'uMouseRadius'
    ];
    var loc = {};
    UNIFORMS.forEach(function (n) { loc[n] = gl.getUniformLocation(prog, n); });

    function setVec2(n, v) { var l = loc[n]; if (l) gl.uniform2f(l, v[0], v[1]); }
    function setVec3(n, v) { var l = loc[n]; if (l) gl.uniform3f(l, v[0], v[1], v[2]); }
    function set1f(n, v) { var l = loc[n]; if (l) gl.uniform1f(l, v); }
    function set1i(n, v) { var l = loc[n]; if (l) gl.uniform1i(l, v); }

    var state = {
      colors: opts.colors,
      speed: opts.speed != null ? opts.speed : 0.4,
      scale: opts.scale != null ? opts.scale : 1.4,
      turbulence: opts.turbulence != null ? opts.turbulence : 1,
      fluidity: opts.fluidity != null ? opts.fluidity : 0.12,
      rimWidth: opts.rimWidth != null ? opts.rimWidth : 0.2,
      sharpness: opts.sharpness != null ? opts.sharpness : 2.2,
      shimmer: opts.shimmer != null ? opts.shimmer : 1.2,
      glow: opts.glow != null ? opts.glow : 1.15,
      flowDirection: opts.flowDirection || 'down',
      opacity: opts.opacity != null ? opts.opacity : 1,
      mouseStrength: opts.mouseStrength != null ? opts.mouseStrength : 0.9,
      mouseRadius: opts.mouseRadius != null ? opts.mouseRadius : 0.35
    };
    var mouseInteraction = opts.mouseInteraction !== false;
    var mouseDampening = opts.mouseDampening != null ? opts.mouseDampening : 0.15;

    /* Fullscreen triangle covering the viewport. */
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var posLoc = gl.getAttribLocation(prog, 'position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);

    var iMouse = [0, 0];
    var mouseTarget = [0, 0];
    var lastTime = 0;
    var raf = 0;

    function applyColors() {
      var p = prepColors(state.colors);
      for (var i = 0; i < MAX_COLORS; i++) setVec3('uColor' + i, p.arr[i]);
      set1i('uColorCount', p.count);
      setVec3('uMouseColor', p.avg);
    }

    function applyState() {
      applyColors();
      setVec2('uFlow', flowVec(state.flowDirection));
      set1f('uSpeed', state.speed);
      set1f('uScale', state.scale);
      set1f('uTurbulence', state.turbulence);
      set1f('uFluidity', state.fluidity);
      set1f('uRimWidth', state.rimWidth);
      set1f('uSharpness', state.sharpness);
      set1f('uShimmer', state.shimmer);
      set1f('uGlow', state.glow);
      set1f('uOpacity', state.opacity);
      set1f('uMouseEnabled', mouseInteraction ? 1 : 0);
      set1f('uMouseStrength', state.mouseStrength);
      set1f('uMouseRadius', state.mouseRadius);
      setVec3('iResolution', [gl.drawingBufferWidth, gl.drawingBufferHeight, 1]);
      setVec2('iMouse', iMouse);
      set1f('iTime', 0);
    }

    function resize() {
      var w = Math.max(1, Math.round(window.innerWidth * dpr));
      var h = Math.max(1, Math.round(window.innerHeight * dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      setVec3('iResolution', [gl.drawingBufferWidth, gl.drawingBufferHeight, 1]);
    }

    function onPointer(e) {
      mouseTarget[0] = e.clientX * dpr;
      mouseTarget[1] = (window.innerHeight - e.clientY) * dpr;
      if (mouseDampening <= 0) setVec2('iMouse', mouseTarget);
    }

    function drawFrame(t) {
      raf = requestAnimationFrame(drawFrame);
      set1f('iTime', t * 0.001);
      if (mouseDampening > 0) {
        var dt = lastTime ? (t - lastTime) / 1000 : 0;
        lastTime = t;
        var factor = Math.min(1, 1 - Math.exp(-dt / Math.max(1e-4, mouseDampening)));
        iMouse[0] += (mouseTarget[0] - iMouse[0]) * factor;
        iMouse[1] += (mouseTarget[1] - iMouse[1]) * factor;
        setVec2('iMouse', iMouse);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function drawStatic() {
      set1f('iTime', 0.6);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    /* ---- init ---- */
    applyState();
    resize();

    if (running) {
      raf = requestAnimationFrame(drawFrame);
    } else {
      drawStatic();
    }

    if (mouseInteraction) {
      window.addEventListener('pointermove', onPointer, { passive: true });
    }
    window.addEventListener('resize', resize);

    canvas.addEventListener('webglcontextlost', function (e) {
      e.preventDefault();
      document.body.classList.remove('has-ferro');
    });

    return {
      setColors: function (colors) { state.colors = colors; applyColors(); },
      applyTheme: function () {
        var t = themeFor();
        state.colors = t.colors;
        state.glow = t.glow;
        applyColors();
        set1f('uGlow', t.glow);
      },
      destroy: function () {
        if (raf) cancelAnimationFrame(raf);
        if (mouseInteraction) window.removeEventListener('pointermove', onPointer);
        window.removeEventListener('resize', resize);
        document.body.classList.remove('has-ferro');
        if (gl.getExtension('WEBGL_lose_context')) {
          gl.getExtension('WEBGL_lose_context').loseContext();
        }
      },
      get running() { return running; }
    };
  }

  window.Ferrofluid = { create: createFerrofluid, instance: null };

  function boot() {
    var canvas = document.getElementById('ferro');
    if (!canvas) return;
    var theme = themeFor();
    try {
      window.Ferrofluid.instance = createFerrofluid(canvas, {
        colors: theme.colors,
        glow: theme.glow,
        dpr: 2,
        speed: 0.4,
        scale: 1.4,
        turbulence: 1,
        fluidity: 0.12,
        rimWidth: 0.2,
        sharpness: 2.2,
        shimmer: 1.2,
        flowDirection: 'down',
        opacity: 1,
        mouseInteraction: true,
        mouseStrength: 0.9,
        mouseRadius: 0.35,
        mouseDampening: 0.15
      });
      document.body.classList.add('has-ferro');
    } catch (e) {
      if (window.console) console.warn('Ferrofluid disabled:', e && e.message ? e.message : e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
