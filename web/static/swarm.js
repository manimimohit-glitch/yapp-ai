/* ============================================================
   Yapp.ai — SwarmCursor (vanilla WebGL port)
   ------------------------------------------------------------
   Living particles that follow the cursor with organic Perlin
   noise flocking, metaball-merge rendering, trail system,
   and click-to-scatter. Originally ogl + React; ported to raw
   WebGL1 for the static FastAPI site.

   Auto-inits a <div id="swarm"> overlay. Falls back silently
   if WebGL is unavailable. Theme-aware colors.
   ============================================================ */
(function () {
  'use strict';

  /* ---- helpers ---- */
  function hexToRgb(hex) {
    var h = (hex || '').replace('#', '').trim();
    if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
    var n = parseInt(h || '000000', 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  function buildPerm() {
    var src = new Uint8Array(256);
    for (var i = 0; i < 256; i++) src[i] = i;
    for (var i = 255; i > 0; i--) {
      var j = (Math.random() * (i + 1)) | 0;
      var t = src[i]; src[i] = src[j]; src[j] = t;
    }
    var perm = new Uint16Array(512);
    for (var i = 0; i < 512; i++) perm[i] = src[i & 255];
    return perm;
  }
  var smoothFade = function (t) { return t * t * t * (t * (t * 6 - 15) + 10); };
  var gradDot = function (h, x, y, z) {
    var u = h < 8 ? x : y, v = h < 4 ? y : h === 12 || h === 14 ? x : z;
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
  };
  function noise3(perm, x, y, z) {
    var fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
    var X = fx & 255, Y = fy & 255, Z = fz & 255;
    var rx = x - fx, ry = y - fy, rz = z - fz;
    var u = smoothFade(rx), v = smoothFade(ry), w = smoothFade(rz);
    var A = perm[X] + Y, AA = perm[A & 511] + Z, AB = perm[(A + 1) & 511] + Z;
    var B = perm[(X + 1) & 511] + Y, BA = perm[B & 511] + Z, BB = perm[(B + 1) & 511] + Z;
    var g000 = gradDot(perm[AA & 511] & 15, rx, ry, rz);
    var g100 = gradDot(perm[BA & 511] & 15, rx - 1, ry, rz);
    var g010 = gradDot(perm[AB & 511] & 15, rx, ry - 1, rz);
    var g110 = gradDot(perm[BB & 511] & 15, rx - 1, ry - 1, rz);
    var g001 = gradDot(perm[(AA + 1) & 511] & 15, rx, ry, rz - 1);
    var g101 = gradDot(perm[(BA + 1) & 511] & 15, rx - 1, ry, rz - 1);
    var g011 = gradDot(perm[(AB + 1) & 511] & 15, rx, ry - 1, rz - 1);
    var g111 = gradDot(perm[(BB + 1) & 511] & 15, rx - 1, ry - 1, rz - 1);
    var x00 = g000 + u * (g100 - g000), x10 = g010 + u * (g110 - g010);
    var x01 = g001 + u * (g101 - g001), x11 = g011 + u * (g111 - g011);
    return (x00 + v * (x10 - x00)) + w * ((x01 + v * (x11 - x01)) - (x00 + v * (x10 - x00)));
  }

  /* ---- shaders ---- */
  var FIELD_VERT = 'precision highp float;\nattribute vec2 position;\nattribute vec2 aLocal;\nattribute float aWeight;\nuniform vec2 uRes;\nvarying vec2 vLocal;\nvarying float vWeight;\nvoid main(){\nvLocal=aLocal;\nvWeight=aWeight;\nvec2 clip=(position/uRes)*2.0-1.0;\ngl_Position=vec4(clip.x,-clip.y,0.0,1.0);\n}';
  var FIELD_FRAG = 'precision highp float;\nvarying vec2 vLocal;\nvarying float vWeight;\nvoid main(){\nfloat d=length(vLocal);\nfloat a=exp(-d*d*3.6)*vWeight;\ngl_FragColor=vec4(a,a,a,a);\n}';
  var COMP_VERT = 'precision highp float;\nattribute vec2 position;\nvarying vec2 vUv;\nvoid main(){\nvUv=position*0.5+0.5;\ngl_Position=vec4(position,0.0,1.0);\n}';
  var COMP_FRAG = 'precision highp float;\nuniform sampler2D tField;\nuniform vec3 uColor;\nuniform vec3 uAccent;\nuniform float uMerge;\nuniform float uGlow;\nuniform float uOpacity;\nvarying vec2 vUv;\nvoid main(){\nfloat f=texture2D(tField,vUv).r;\nfloat edge=uMerge*0.3;\nfloat core=smoothstep(uMerge-edge,uMerge+edge,f);\nfloat halo=smoothstep(uMerge*0.12,uMerge,f);\nvec3 col=mix(uColor,uAccent,clamp(f/max(uMerge*2.4,0.001),0.0,1.0));\nfloat alpha=(core+halo*uGlow*(1.0-core))*uOpacity;\nif(alpha<=0.002)discard;\ngl_FragColor=vec4(col*alpha,alpha);\n}';

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
  function createFBO(gl, w, h) {
    var fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    var tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fb: fb, tex: tex, w: w, h: h };
  }

  /* ---- theme ---- */
  function themeColors() {
    var dark = document.documentElement.dataset.theme === 'dark';
    return dark
      ? { color: '#ffffff', accent: '#ffffff' }
      : { color: '#171a26', accent: '#3b82f6' };
  }

  /* ---- engine ---- */
  var MAX = 120, MAX_QUADS = 6000, HISTORY = 120;

  function createSwarm(container, opts) {
    opts = opts || {};

    var canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;';
    canvas.setAttribute('aria-hidden', 'true');
    container.appendChild(canvas);

    var gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false });
    if (!gl) throw new Error('WebGL not supported');

    var dpr = Math.min(opts.dpr != null ? opts.dpr : (window.devicePixelRatio || 1), 1.75);
    gl.clearColor(0, 0, 0, 0);

    var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* programs */
    var fieldProg = mkProgram(gl, mkShader(gl, gl.VERTEX_SHADER, FIELD_VERT), mkShader(gl, gl.FRAGMENT_SHADER, FIELD_FRAG));
    var compProg = mkProgram(gl, mkShader(gl, gl.VERTEX_SHADER, COMP_VERT), mkShader(gl, gl.FRAGMENT_SHADER, COMP_FRAG));

    /* field geometry */
    var positions = new Float32Array(MAX_QUADS * 8);
    var locals = new Float32Array(MAX_QUADS * 8);
    var weights = new Float32Array(MAX_QUADS * 4);
    var indices = new Uint16Array(MAX_QUADS * 6);
    for (var i = 0; i < MAX_QUADS; i++) {
      var v = i * 4; locals.set([-1, -1, 1, -1, 1, 1, -1, 1], v * 2);
      indices.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
    }
    var posBuf = gl.createBuffer(), locBuf = gl.createBuffer(), wgtBuf = gl.createBuffer(), idxBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, locBuf); gl.bufferData(gl.ARRAY_BUFFER, locals, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf); gl.bufferData(gl.ARRAY_BUFFER, positions.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, wgtBuf); gl.bufferData(gl.ARRAY_BUFFER, weights.byteLength, gl.DYNAMIC_DRAW);

    /* field attribute locations */
    var fPos = gl.getAttribLocation(fieldProg, 'position');
    var fLoc = gl.getAttribLocation(fieldProg, 'aLocal');
    var fWgt = gl.getAttribLocation(fieldProg, 'aWeight');
    var uRes = gl.getUniformLocation(fieldProg, 'uRes');

    /* comp fullscreen triangle */
    var compBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, compBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var cPos = gl.getAttribLocation(compProg, 'position');
    var cField = gl.getUniformLocation(compProg, 'tField');
    var cColor = gl.getUniformLocation(compProg, 'uColor');
    var cAccent = gl.getUniformLocation(compProg, 'uAccent');
    var cMerge = gl.getUniformLocation(compProg, 'uMerge');
    var cGlow = gl.getUniformLocation(compProg, 'uGlow');
    var cOpacity = gl.getUniformLocation(compProg, 'uOpacity');

    /* state */
    var state = {
      color: opts.color || themeColors().color,
      accent: opts.accent || themeColors().accent,
      count: opts.count != null ? opts.count : 12,
      size: opts.size != null ? opts.size : 5,
      merge: opts.merge != null ? opts.merge : 0.77,
      glow: opts.glow != null ? opts.glow : 0.75,
      opacity: opts.opacity != null ? opts.opacity : 0.85,
      spread: opts.spread != null ? opts.spread : 100,
      separation: opts.separation != null ? opts.separation : 0.15,
      speed: opts.speed != null ? opts.speed : 2.5,
      wander: opts.wander != null ? opts.wander : 0.25,
      trail: opts.trail != null ? opts.trail : 0.75,
      scatterOnClick: opts.scatterOnClick !== false,
      enabled: opts.enabled !== false
    };

    var perm = buildPerm();
    var px = new Float32Array(MAX), py = new Float32Array(MAX);
    var vx = new Float32Array(MAX), vy = new Float32Array(MAX);
    var scale = new Float32Array(MAX), agility = new Float32Array(MAX);
    var handed = new Float32Array(MAX), noiseX = new Float32Array(MAX), noiseY = new Float32Array(MAX);
    var histX = new Float32Array(HISTORY * MAX), histY = new Float32Array(HISTORY * MAX), histT = new Float32Array(HISTORY);
    var histHead = 0, histLen = 0, lastSample = -1;

    var cssW = 1, cssH = 1, fbo = null;
    var cursor = { x: 0, y: 0, has: false };
    var burst = 0, activeCount = 0;
    var raf = 0, last = performance.now(), disposed = false;

    function spawn(i, ox, oy) {
      var a = Math.random() * Math.PI * 2, r = 40 + Math.random() * 120;
      px[i] = ox + Math.cos(a) * r; py[i] = oy + Math.sin(a) * r;
      vx[i] = Math.cos(a) * 60; vy[i] = Math.sin(a) * 60;
      for (var h = 0; h < HISTORY; h++) { histX[h * MAX + i] = px[i]; histY[h * MAX + i] = py[i]; }
    }

    for (var i = 0; i < MAX; i++) {
      spawn(i, 0, 0); scale[i] = 0.65 + Math.random() * 0.6;
      agility[i] = 0.75 + Math.random() * 0.5;
      handed[i] = Math.random() < 0.5 ? -1 : 1;
      noiseX[i] = Math.random() * 260; noiseY[i] = Math.random() * 260;
    }

    function resize() {
      cssW = container.clientWidth || 1; cssH = container.clientHeight || 1;
      canvas.width = Math.max(1, Math.round(cssW * dpr));
      canvas.height = Math.max(1, Math.round(cssH * dpr));
      fbo = createFBO(gl, canvas.width, canvas.height);
    }
    var ro = new ResizeObserver(resize);
    ro.observe(container);
    resize();

    /* events (window-level since canvas is pointer-events:none) */
    function onMove(e) {
      var r = container.getBoundingClientRect();
      cursor.x = e.clientX - r.left; cursor.y = e.clientY - r.top; cursor.has = true;
    }
    function onDown(e) {
      if (!state.scatterOnClick || !state.enabled) return;
      var r = container.getBoundingClientRect();
      var cx = e.clientX - r.left, cy = e.clientY - r.top;
      var escape = 620 + state.speed * 130;
      for (var i = 0; i < MAX; i++) {
        var dx = px[i] - cx, dy = py[i] - cy, d = Math.hypot(dx, dy);
        if (d < 1e-3) { var a = Math.random() * Math.PI * 2; dx = Math.cos(a); dy = Math.sin(a); d = 1; }
        var kick = escape * (0.75 + Math.random() * 0.5);
        vx[i] = (dx / d) * kick; vy[i] = (dy / d) * kick;
      }
      burst = 1;
    }
    window.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerdown', onDown);

    var nowSec = 0;

    function frame(now) {
      raf = requestAnimationFrame(frame);
      if (disposed) return;
      var dt = Math.min((now - last) / 1000, 0.05); last = now;
      nowSec = now * 0.001;

      if (!state.enabled || reduceMotion) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clear(gl.COLOR_BUFFER_BIT);
        return;
      }

      var n = Math.max(1, Math.min(MAX, Math.round(state.count)));
      var anchorX = cursor.has ? cursor.x : cssW * 0.5;
      var anchorY = cursor.has ? cursor.y : cssH * 0.5;
      for (var i = activeCount; i < n; i++) { spawn(i, anchorX, anchorY); px[i] = anchorX; py[i] = anchorY; }
      activeCount = n;

      burst = Math.max(0, burst - dt / 0.5);
      var maxSpeed = 110 + Math.max(0.1, state.speed) * 165;
      var steerRate = 4.5 + Math.max(0.1, state.speed) * 1.15;
      var maxForce = maxSpeed * 9;
      var band = Math.max(20, state.spread * 0.55);
      var sepDist = Math.max(1, state.spread * 0.42 * (0.35 + state.separation));
      var flowMix = state.wander * 2.4;
      var eps = 0.08, baseScale = 0.0016, fineScale = baseScale * 3.6;

      for (var i = 0; i < n; i++) {
        var dx = anchorX - px[i], dy = anchorY - py[i], dist = Math.hypot(dx, dy) || 1e-4;
        var ux = dx / dist, uy = dy / dist;
        var orbitDrift = noise3(perm, noiseX[i], noiseY[i], nowSec * 0.13);
        var orbit = band * (0.34 + 1.35 * Math.max(0, Math.min(1, orbitDrift + 0.5)));
        var radial = Math.max(-1, Math.min(1, (dist - orbit) / (band * 0.85)));
        var swirl = Math.sqrt(Math.max(0, 1 - radial * radial)) * handed[i];
        var wishX = ux * radial - uy * swirl, wishY = uy * radial + ux * swirl;

        if (flowMix > 0.001) {
          var bx = px[i] * baseScale, by = py[i] * baseScale, bt = nowSec * 0.22;
          var coarseX = (noise3(perm, bx, by + eps, bt) - noise3(perm, bx, by - eps, bt)) / (2 * eps);
          var coarseY = -(noise3(perm, bx + eps, by, bt) - noise3(perm, bx - eps, by, bt)) / (2 * eps);
          var fx = px[i] * fineScale + noiseX[i], fy = py[i] * fineScale + noiseY[i], ft = nowSec * 0.55;
          var fineX = (noise3(perm, fx, fy + eps, ft) - noise3(perm, fx, fy - eps, ft)) / (2 * eps);
          var fineY = -(noise3(perm, fx + eps, fy, ft) - noise3(perm, fx - eps, fy, ft)) / (2 * eps);
          wishX += (coarseX + fineX * 0.7) * flowMix;
          wishY += (coarseY + fineY * 0.7) * flowMix;
        }
        var wl = Math.hypot(wishX, wishY) || 1e-4; wishX /= wl; wishY /= wl;

        var rate = steerRate * agility[i] * (1 - burst);
        var ax = (wishX * maxSpeed - vx[i]) * rate, ay = (wishY * maxSpeed - vy[i]) * rate;
        if (burst > 0.001) { ax -= ux * maxSpeed * burst * 5.5; ay -= uy * maxSpeed * burst * 5.5; }

        for (var j = 0; j < n; j++) {
          if (j === i) continue;
          var sx = px[i] - px[j], sy = py[i] - py[j], d2 = sx * sx + sy * sy;
          if (d2 > 1e-4 && d2 < sepDist * sepDist) {
            var d = Math.sqrt(d2), f = (1 - d / sepDist) * maxSpeed * 3.2 * state.separation;
            ax += (sx / d) * f; ay += (sy / d) * f;
          }
        }
        var al = Math.hypot(ax, ay), cap = maxForce * (1 + burst * 4);
        if (al > cap) { ax = (ax / al) * cap; ay = (ay / al) * cap; }
        vx[i] += ax * dt; vy[i] += ay * dt;

        var sp = Math.hypot(vx[i], vy[i]), hi = maxSpeed * (1 + burst * 3.5), lo = maxSpeed * 0.32;
        if (sp > hi) { vx[i] = (vx[i] / sp) * hi; vy[i] = (vy[i] / sp) * hi; }
        else if (sp < lo && sp > 1e-4) { vx[i] = (vx[i] / sp) * lo; vy[i] = (vy[i] / sp) * lo; }
        px[i] += vx[i] * dt; py[i] += vy[i] * dt;
      }

      /* trail sampling */
      if (lastSample < 0 || nowSec - lastSample >= 0.008) {
        lastSample = nowSec; histT[histHead] = nowSec;
        var base = histHead * MAX;
        for (var i = 0; i < n; i++) { histX[base + i] = px[i]; histY[base + i] = py[i]; }
        histHead = (histHead + 1) % HISTORY; if (histLen < HISTORY) histLen++;
      }

      /* build quads */
      var trailAge = state.trail * 0.85;
      var perAgent = Math.max(0, Math.floor(MAX_QUADS / n) - 1);
      var maxStamps = Math.min(46, perAgent);
      var quad = 0;
      var scX = dpr, scY = dpr;

      function pushQuad(cx, cy, r, w) {
        var v = quad * 8, o = quad * 4;
        positions[v] = cx * scX - r * scX; positions[v + 1] = cy * scY - r * scY;
        positions[v + 2] = cx * scX + r * scX; positions[v + 3] = cy * scY - r * scY;
        positions[v + 4] = cx * scX + r * scX; positions[v + 5] = cy * scY + r * scY;
        positions[v + 6] = cx * scX - r * scX; positions[v + 7] = cy * scY + r * scY;
        weights[o] = w; weights[o + 1] = w; weights[o + 2] = w; weights[o + 3] = w;
        quad++;
      }

      for (var i = 0; i < n; i++) {
        var headR = state.size * scale[i] * 2.1;
        var headW = 1.06 + 0.3 * scale[i];
        pushQuad(px[i], py[i], headR, headW);
        if (trailAge < 0.01 || maxStamps < 2 || histLen < 2) continue;
        var step = Math.max(2, state.size * scale[i] * 0.5);
        var span = step * maxStamps;
        var prevX = px[i], prevY = py[i], walked = 0, nextAt = step, stamps = 0;
        for (var j = 0; j < histLen && stamps < maxStamps; j++) {
          var slot = (histHead - 1 - j + HISTORY) % HISTORY;
          if (nowSec - histT[slot] > trailAge) break;
          var hx = histX[slot * MAX + i], hy = histY[slot * MAX + i];
          var segX = hx - prevX, segY = hy - prevY, segLen = Math.hypot(segX, segY);
          if (segLen < 1e-4) continue;
          while (nextAt <= walked + segLen && stamps < maxStamps) {
            var f = (nextAt - walked) / segLen, u = nextAt / span;
            var taper = Math.pow(Math.max(0, 1 - u), 0.55);
            var rLocal = headR * taper;
            if (rLocal < step) { stamps = maxStamps; break; }
            var stampW = Math.min(headW, (headW * step) / (rLocal * 0.934));
            pushQuad(prevX + segX * f, prevY + segY * f, rLocal, stampW);
            stamps++; nextAt += step;
          }
          walked += segLen; prevX = hx; prevY = hy;
        }
      }

      /* ---- render ---- */
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, positions);
      gl.bindBuffer(gl.ARRAY_BUFFER, wgtBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, weights);

      /* field pass → FBO */
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo ? fbo.fb : null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);

      gl.useProgram(fieldProg);
      gl.uniform2f(uRes, canvas.width, canvas.height);

      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf); gl.enableVertexAttribArray(fPos); gl.vertexAttribPointer(fPos, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, locBuf); gl.enableVertexAttribArray(fLoc); gl.vertexAttribPointer(fLoc, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, wgtBuf); gl.enableVertexAttribArray(fWgt); gl.vertexAttribPointer(fWgt, 1, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);

      gl.drawElements(gl.TRIANGLES, quad * 6, gl.UNSIGNED_SHORT, 0);

      /* composite pass → screen */
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      gl.useProgram(compProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, fbo ? fbo.tex : null);
      gl.uniform1i(cField, 0);
      var c = hexToRgb(state.color), a = hexToRgb(state.accent);
      gl.uniform3f(cColor, c[0], c[1], c[2]);
      gl.uniform3f(cAccent, a[0], a[1], a[2]);
      gl.uniform1f(cMerge, state.merge);
      gl.uniform1f(cGlow, state.glow);
      gl.uniform1f(cOpacity, state.opacity);

      gl.disableVertexAttribArray(fPos); gl.disableVertexAttribArray(fLoc); gl.disableVertexAttribArray(fWgt);
      gl.bindBuffer(gl.ARRAY_BUFFER, compBuf); gl.enableVertexAttribArray(cPos); gl.vertexAttribPointer(cPos, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    raf = requestAnimationFrame(frame);

    return {
      applyTheme: function () {
        var t = themeColors(); state.color = t.color; state.accent = t.accent;
      },
      destroy: function () {
        disposed = true; cancelAnimationFrame(raf); ro.disconnect();
        window.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerdown', onDown);
        if (canvas.parentNode === container) container.removeChild(canvas);
        try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch (_) {}
      }
    };
  }

  /* ---- auto-init ---- */
  window.SwarmCursor = { create: createSwarm, instance: null };
  function boot() {
    var container = document.getElementById('swarm');
    if (!container) return;
    try {
      var tc = themeColors();
      window.SwarmCursor.instance = createSwarm(container, {
        color: tc.color, accent: tc.accent,
        count: 12, size: 5, speed: 2.5, spread: 100,
        wander: 0.25, trail: 0.75, scatterOnClick: true, opacity: 0.85
      });
      document.body.classList.add('has-swarm');
    } catch (e) {
      if (window.console) console.warn('SwarmCursor disabled:', e && e.message ? e.message : e);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
