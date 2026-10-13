<script lang="ts">
  import { onMount } from "svelte";

  let canvas = $state<HTMLCanvasElement | null>(null);

  onMount(() => {
    const el = canvas;
    if (!el) return;

    const ctx = el.getContext("webgl", { antialias: false, depth: false, stencil: false, alpha: false });
    if (!ctx) return;
    const gl = ctx;

    const vsSource = `
      attribute vec2 a_pos;
      void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
    `;

    const fsSource = `
      precision mediump float;
      uniform vec2 u_res;
      uniform float u_time;
      uniform vec2 u_mouse;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }

      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
          mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
          u.y
        );
      }

      float fbm(vec2 p) {
        float v = 0.0;
        float a = 0.5;
        for (int i = 0; i < 4; i++) {
          v += a * noise(p);
          p = p * 2.03 + vec2(1.7, 9.2);
          a *= 0.5;
        }
        return v;
      }

      void main() {
        vec2 uv = gl_FragCoord.xy / u_res;
        float aspect = u_res.x / u_res.y;
        vec2 p = vec2(uv.x * aspect, uv.y);
        vec2 m = vec2(u_mouse.x / u_res.x * aspect, u_mouse.y / u_res.y);

        float t = u_time * 0.08;
        float d = length(p - m);

        float n = fbm(p * 3.0 + vec2(t, -t * 0.7));

        float core = exp(-d * d * 12.0);
        float halo = exp(-d * 3.2) * 0.07;
        float v = (core * 0.28 + halo) * (0.75 + 0.5 * n);

        vec3 ink = vec3(0.039, 0.051, 0.071);
        vec3 ember = vec3(1.0, 0.604, 0.239);
        vec3 amber = vec3(1.0, 0.706, 0.329);

        vec3 col = ink;
        col = mix(col, ember, clamp(v, 0.0, 1.0));
        col = mix(col, amber, clamp(v * v * 1.5, 0.0, 1.0));

        float vig = smoothstep(1.35, 0.35, length(uv - vec2(0.5)) * 1.7);
        col *= mix(0.85, 1.0, vig);

        float g = (hash(gl_FragCoord.xy + fract(u_time) * 7.0) - 0.5) * 0.018;
        col += g;

        gl_FragColor = vec4(col, 1.0);
      }
    `;

    function compile(type: number, source: string) {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    }

    const vs = compile(gl.VERTEX_SHADER, vsSource);
    const fs = compile(gl.FRAGMENT_SHADER, fsSource);
    if (!vs || !fs) return;

    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      return;
    }
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(program, "u_res");
    const uTime = gl.getUniformLocation(program, "u_time");
    const uMouse = gl.getUniformLocation(program, "u_mouse");

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let targetX = window.innerWidth * 0.5;
    let targetY = window.innerHeight * 0.6;
    let curX = targetX;
    let curY = targetY;
    let raf = 0;
    const start = performance.now();

    function resize() {
      const low = el!.dataset.lowq === "1";
      const dpr = low ? 0.25 : Math.min(window.devicePixelRatio || 1, 1.25);
      const w = Math.max(1, Math.round(el!.clientWidth * dpr));
      const h = Math.max(1, Math.round(el!.clientHeight * dpr));
      if (el!.width !== w || el!.height !== h) {
        el!.width = w;
        el!.height = h;
        gl.viewport(0, 0, w, h);
      }
    }

    function draw(time: number) {
      resize();
      const dpr = Math.min(window.devicePixelRatio || 1, 1.25);
      gl.uniform2f(uRes, el!.width, el!.height);
      gl.uniform1f(uTime, time);
      gl.uniform2f(uMouse, curX * dpr, (el!.clientHeight - curY) * dpr);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function frame(now: number) {
      curX += (targetX - curX) * 0.055;
      curY += (targetY - curY) * 0.055;
      draw((now - start) / 1000);
      raf = requestAnimationFrame(frame);
    }

    function onMove(e: PointerEvent) {
      targetX = e.clientX;
      targetY = e.clientY;
    }

    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let resizing = false;

    function setQuality(low: boolean) {
      el!.dataset.lowq = low ? "1" : "0";
    }

    function onResize() {
      if (!resizing) {
        resizing = true;
        setQuality(true);
      }
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizing = false;
        setQuality(false);
        resize();
        draw((performance.now() - start) / 1000);
      }, 140);
    }

    window.addEventListener("resize", onResize, { passive: true });

    if (reduced) {
      draw(0);
    } else {
      window.addEventListener("pointermove", onMove, { passive: true });
      raf = requestAnimationFrame(frame);
    }

    return () => {
      clearTimeout(resizeTimer);
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    };
  });
</script>

<canvas bind:this={canvas} class="absolute inset-0 h-full w-full" aria-hidden="true"></canvas>
