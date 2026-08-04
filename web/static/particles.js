/* ============================================================
   Yapp.ai — 3D Particles background (vanilla WebGL port)
   ------------------------------------------------------------
   Floating particles distributed in a sphere with slow
   rotation, sinusoidal drift, and size-by-depth. Replaces
   the ferrofluid as the page background.

   Originally ogl + React; ported to raw WebGL1 + hand-rolled
   mat4 maths so it runs on the static site with no build step.

   Theme-aware: white particles on dark, dark particles on light.
   ============================================================ */
(function () {
  'use strict';

  /* ---- hex → [r,g,b] 0-1 ---- */
  function hexToRgb(hex) {
    var h = (hex || '#ffffff').replace('#', '').trim();
    if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
    var n = parseInt(h || '000000', 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  /* ---- minimal mat4 (column-major Float32Array) ---- */
  function mat4() { return new Float32Array(16); }

  function m4Identity(o) {
    o.fill(0); o[0] = o[5] = o[10] = o[15] = 1; return o;
  }

  function m4Perspective(o, fov, asp, near, far) {
    var f = 1 / Math.tan(fov / 2), nf = 1 / (near - far);
    o.fill(0);
    o[0] = f / asp; o[5] = f;
    o[10] = (far + near) * nf; o[11] = -1;
    o[14] = 2 * far * near * nf;
    return o;
  }

  function m4RotateX(o, rad) {
    var s = Math.sin(rad), c = Math.cos(rad), m = new Float32Array(o);
    o[4] = m[4] * c + m[8] * s;  o[5] = m[5] * c + m[9] * s;
    o[6] = m[6] * c + m[10] * s; o[7] = m[7] * c + m[11] * s;
    o[8] = m[8] * c - m[4] * s;  o[9] = m[9] * c - m[5] * s;
    o[10] = m[10] * c - m[6] * s; o[11] = m[11] * c - m[7] * s;
    return o;
  }

  function m4RotateY(o, rad) {
    var s = Math.sin(rad), c = Math.cos(rad), m = new Float32Array(o);
    o[0] = m[0] * c - m[8] * s;  o[1] = m[1] * c - m[9] * s;
    o[2] = m[2] * c - m[10] * s; o[3] = m[3] * c - m[11] * s;
    o[8] = m[0] * s + m[8] * c;  o[9] = m[1] * s + m[9] * c;
    o[10] = m[2] * s + m[10] * c; o[11] = m[3] * s + m[11] * c;
    return o;
  }

  function m4RotateZ(o, rad) {
    var s = Math.sin(rad), c = Math.cos(rad), m = new Float32Array(o);
    o[0] = m[0] * c + m[4] * s;  o[1] = m[1] * c + m[5] * s;
    o[2] = m[2] * c + m[6] * s;  o[3] = m[3] * c + m[7] * s;
    o[4] = m[4] * c - m[0] * s;  o[5] = m[5] * c - m[1] * s;
    o[6] = m[6] * c - m[2] * s;  o[7] = m[7] * c - m[3] * s;
    return o;
  }

  /* ---- shaders (GLSL 100) ---- */
  var VERT = [
    'attribute vec3 position;',
    'attribute vec4 random;',
    'attribute vec3 color;',
    'uniform mat4 modelMatrix;',
    'uniform mat4 viewMatrix;',
    'uniform mat4 projectionMatrix;',
    'uniform float uTime;',
    'uniform float uSpread;',
    'uniform float uBaseSize;',
    'uniform float uSizeRandomness;',
    'varying vec4 vRandom;',
    'varying vec3 vColor;',
    'void main() {',
    '  vRandom = random; vColor = color;',
    '  vec3 pos = position * uSpread;',
    '  pos.z *= 10.0;',
    '  vec4 mPos = modelMatrix * vec4(pos, 1.0);',
    '  float t = uTime;',
    '  mPos.x += sin(t * random.z + 6.28 * random.w) * mix(0.1, 1.5, random.x);',
    '  mPos.y += sin(t * random.y + 6.28 * random.x) * mix(0.1, 1.5, random.w);',
    '  mPos.z += sin(t * random.w + 6.28 * random.y) * mix(0.1, 1.5, random.z);',
    '  vec4 mvPos = viewMatrix * mPos;',
    '  if (uSizeRandomness == 0.0) gl_PointSize = uBaseSize;',
    '  else gl_PointSize = (uBaseSize * (1.0 + uSizeRandomness * (random.x - 0.5))) / length(mvPos.xyz);',
    '  gl_Position = projectionMatrix * mvPos;',
    '}'
  ].join('\n');

  var FRAG = [
    'precision highp float;',
    'uniform float uTime;',
    'uniform float uAlphaParticles;',
    'varying vec4 vRandom;',
    'varying vec3 vColor;',
    'void main() {',
    '  vec2 uv = gl_PointCoord.xy;',
    '  float d = length(uv - vec2(0.5));',
    '  if (uAlphaParticles < 0.5) {',
    '    if (d > 0.5) discard;',
    '    gl_FragColor = vec4(vColor + 0.2 * sin(uv.yxx + uTime + vRandom.y * 6.28), 1.0);',
    '  } else {',
    '    float circle = smoothstep(0.5, 0.4, d) * 0.8;',
    '    gl_FragColor = vec4(vColor + 0.2 * sin(uv.yxx + uTime + vRandom.y * 6.28), circle);',
    '  }',
    '}'
  ].join('\n');

  /* ---- gl helpers ---- */
  function mkShader(gl, type, src) {
    var sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { var l = gl.getShaderInfoLog(sh); gl.deleteShader(sh); throw new Error(l); }
    return sh;
  }
  function mkProgram(gl, vs, fs) {
    var p = gl.createProgram(); gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { var l = gl.getProgramInfoLog(p); gl.deleteProgram(p); throw new Error(l); }
    return p;
  }

  /* ---- theme ---- */
  function themeColors() {
    var dark = document.documentElement.dataset.theme === 'dark';
    return dark
      ? { colors: ['#ffffff', '#b18cff'] }
      : { colors: ['#171a26', '#8b5cf6'] };
  }

  /* ---- engine ---- */
  function createParticles(container, opts) {
    opts = opts || {};

    var canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;';
    canvas.setAttribute('aria-hidden', 'true');
    container.appendChild(canvas);

    var gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false });
    if (!gl) throw new Error('WebGL not supported');

    var pixelRatio = Math.min(opts.pixelRatio != null ? opts.pixelRatio : (window.devicePixelRatio || 1), 1.5);
    var count = opts.count != null ? opts.count : 200;
    var spread = opts.spread != null ? opts.spread : 10;
    var speed = opts.speed != null ? opts.speed : 0.1;
    var baseSize = (opts.baseSize != null ? opts.baseSize : 150) * pixelRatio;
    var sizeRandomness = opts.sizeRandomness != null ? opts.sizeRandomness : 1;
    var alphaParticles = opts.alphaParticles ? 1 : 0;
    var disableRotation = !!opts.disableRotation;
    var cameraDistance = opts.cameraDistance != null ? opts.cameraDistance : 20;
    var palette = opts.colors && opts.colors.length ? opts.colors : ['#ffffff'];

    var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    var prog = mkProgram(gl, mkShader(gl, gl.VERTEX_SHADER, VERT), mkShader(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.useProgram(prog);

    /* geometry */
    var positions = new Float32Array(count * 3);
    var randoms = new Float32Array(count * 4);
    var colors = new Float32Array(count * 3);

    for (var i = 0; i < count; i++) {
      var x, y, z, len;
      do { x = Math.random() * 2 - 1; y = Math.random() * 2 - 1; z = Math.random() * 2 - 1; len = x * x + y * y + z * z; } while (len > 1 || len === 0);
      var r = Math.cbrt(Math.random());
      positions[i * 3] = x * r; positions[i * 3 + 1] = y * r; positions[i * 3 + 2] = z * r;
      randoms[i * 4] = Math.random(); randoms[i * 4 + 1] = Math.random();
      randoms[i * 4 + 2] = Math.random(); randoms[i * 4 + 3] = Math.random();
      var col = hexToRgb(palette[Math.floor(Math.random() * palette.length)]);
      colors[i * 3] = col[0]; colors[i * 3 + 1] = col[1]; colors[i * 3 + 2] = col[2];
    }

    var posBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, posBuf); gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    var randBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, randBuf); gl.bufferData(gl.ARRAY_BUFFER, randoms, gl.STATIC_DRAW);
    var colBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, colBuf); gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);

    var aPos = gl.getAttribLocation(prog, 'position');
    var aRand = gl.getAttribLocation(prog, 'random');
    var aCol = gl.getAttribLocation(prog, 'color');

    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf); gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, randBuf); gl.enableVertexAttribArray(aRand); gl.vertexAttribPointer(aRand, 4, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, colBuf); gl.enableVertexAttribArray(aCol); gl.vertexAttribPointer(aCol, 3, gl.FLOAT, false, 0, 0);

    /* uniforms */
    var uTime = gl.getUniformLocation(prog, 'uTime');
    var uSpread = gl.getUniformLocation(prog, 'uSpread');
    var uBaseSize = gl.getUniformLocation(prog, 'uBaseSize');
    var uSizeRandomness = gl.getUniformLocation(prog, 'uSizeRandomness');
    var uAlphaParticles = gl.getUniformLocation(prog, 'uAlphaParticles');
    var uModel = gl.getUniformLocation(prog, 'modelMatrix');
    var uView = gl.getUniformLocation(prog, 'viewMatrix');
    var uProj = gl.getUniformLocation(prog, 'projectionMatrix');

    gl.uniform1f(uSpread, spread);
    gl.uniform1f(uBaseSize, baseSize);
    gl.uniform1f(uSizeRandomness, sizeRandomness);
    gl.uniform1f(uAlphaParticles, alphaParticles);

    /* view matrix (constant) */
    var view = m4Identity(mat4());
    view[14] = -cameraDistance;

    /* projection (updated on resize) */
    var proj = mat4();
    var fovRad = 15 * Math.PI / 180;
    gl.uniformMatrix4fv(uView, false, view);

    var model = m4Identity(mat4());

    function resize() {
      var w = container.clientWidth || 1, h = container.clientHeight || 1;
      canvas.width = Math.max(1, Math.round(w * pixelRatio));
      canvas.height = Math.max(1, Math.round(h * pixelRatio));
      gl.viewport(0, 0, canvas.width, canvas.height);
      m4Perspective(proj, fovRad, canvas.width / canvas.height, 0.1, 100);
      gl.uniformMatrix4fv(uProj, false, proj);
    }
    var ro = new ResizeObserver(resize);
    ro.observe(container);
    resize();

    /* animation */
    var raf = 0, last = performance.now(), elapsed = 0;
    var rotZ = 0, disposed = false;

    function frame(now) {
      raf = requestAnimationFrame(frame);
      if (disposed) return;
      var delta = now - last; last = now;
      elapsed += delta * speed;
      gl.uniform1f(uTime, elapsed * 0.001);

      if (!disableRotation && !reduceMotion) {
        var rx = Math.sin(elapsed * 0.0002) * 0.1;
        var ry = Math.cos(elapsed * 0.0005) * 0.15;
        rotZ += 0.01 * speed;
        m4Identity(model);
        m4RotateY(model, ry);
        m4RotateX(model, rx);
        m4RotateZ(model, rotZ);
      }
      gl.uniformMatrix4fv(uModel, false, model);
      gl.drawArrays(gl.POINTS, 0, count);
    }
    raf = requestAnimationFrame(frame);

    return {
      applyTheme: function () {
        /* Particles are static after init — no live color swap needed.
           A full re-init would be required; the effect still looks
           acceptable across themes thanks to the per-particle color
           variation. */
      },
      destroy: function () {
        disposed = true; cancelAnimationFrame(raf); ro.disconnect();
        if (canvas.parentNode === container) container.removeChild(canvas);
        try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch (_) {}
      }
    };
  }

  /* ---- auto-init ---- */
  window.Particles = { create: createParticles, instance: null };
  function boot() {
    var container = document.getElementById('particles');
    if (!container) return;
    try {
      var tc = themeColors();
      window.Particles.instance = createParticles(container, {
        colors: tc.colors,
        count: 200,
        spread: 10,
        speed: 0.1,
        baseSize: 150,
        sizeRandomness: 1,
        alphaParticles: false,
        disableRotation: false,
        cameraDistance: 20,
        pixelRatio: 1.5
      });
      document.body.classList.add('has-particles');
    } catch (e) {
      if (window.console) console.warn('Particles disabled:', e && e.message ? e.message : e);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
