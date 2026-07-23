import { useCallback, useEffect, useRef, useState } from "react";
import {
  BifurcationRenderer,
  FULL_RES_STEPS_PER_CHUNK,
  type ShaderUniforms,
} from "~/utils/renderer";

// Delay after the last parameter change before the full resolution render
// starts.
const FULL_RES_DELAY_MS = 500;

// Delay before the low-res render kicks in during a zoom gesture. Continuous
// wheel events each cost just one preview quad-draw; once they pause for this
// long, a real (cheap) low-res render refines the preview.
const LOW_RES_ZOOM_DELAY_MS = 100;

// Default view: the Python plot's window r in [2.8, 4], x in [0, 1] =>
// center = (3.4, 0.5), scale (vertical world height) = 1.1.
const INITIAL_SCALE = 1.1;
const INITIAL_CENTER: [number, number] = [3.4, 0.5];

// World bounds the view is allowed to show. Panning/zooming is clamped so the
// view rectangle stays inside these limits. A 1.0 buffer is added around the
// established range so the edge of the shape can be centered on screen.
const R_BOUNDS: [number, number] = [-3, 5];
const X_BOUNDS: [number, number] = [-1, 2];

function clampCenter(
  center: [number, number],
  effSize: [number, number],
): [number, number] {
  const clampAxis = (c: number, bounds: [number, number], span: number) => {
    if (span >= bounds[1] - bounds[0]) return (bounds[0] + bounds[1]) / 2;
    return Math.max(
      bounds[0] + span / 2,
      Math.min(bounds[1] - span / 2, c),
    );
  };
  return [
    clampAxis(center[0], R_BOUNDS, effSize[0]),
    clampAxis(center[1], X_BOUNDS, effSize[1]),
  ];
}

function getEffectiveSize(
  scale: number,
  resolution: [number, number],
): [number, number] {
  const aspectRatio =
    resolution[1] !== 0 ? resolution[0] / resolution[1] : 1;
  return [scale * aspectRatio, scale];
}

function setCanvasSize(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  pixelRatio: number,
) {
  // Only the drawing buffer is sized here; the display size is left to CSS
  // (`w-full h-full`) so the canvas exactly fills its layout box and can never
  // overflow the viewport.
  const bufferWidth = Math.round(width * pixelRatio);
  const bufferHeight = Math.round(height * pixelRatio);

  // Assigning width/height clears the canvas, so only resize when needed.
  if (canvas.width === bufferWidth && canvas.height === bufferHeight) {
    return;
  }

  canvas.width = bufferWidth;
  canvas.height = bufferHeight;
}

// Helper function to get touch distance
function getTouchDistance(touches: TouchList): number {
  if (touches.length < 2) return 0;

  const touch1 = touches[0];
  const touch2 = touches[1];
  const dx = touch1.clientX - touch2.clientX;
  const dy = touch1.clientY - touch2.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

// Helper function to get touch center
function getTouchCenter(touches: TouchList): [number, number] {
  if (touches.length === 1) {
    return [touches[0].clientX, touches[0].clientY];
  }

  const touch1 = touches[0];
  const touch2 = touches[1];
  return [
    (touch1.clientX + touch2.clientX) / 2,
    (touch1.clientY + touch2.clientY) / 2,
  ];
}

function clampScale(value: number): number {
  return Math.max(Math.min(value, 5), 1e-7);
}

function formatCoord(n: number): string {
  return n.toFixed(6);
}

export type InputUniforms = Omit<
  ShaderUniforms,
  "resolution" | "size" | "center" | "pixelRatio"
>;

interface BifurcationCanvasProps {
  lowResScaleFactor: number;
  uniforms: InputUniforms;
}

export default function BifurcationCanvas({
  lowResScaleFactor,
  uniforms,
}: BifurcationCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<BifurcationRenderer | null>(null);

  // Previously rendered view size, used to distinguish a zoom (size changed)
  // from a pan or parameter change in the render effect.
  const prevSizeRef = useRef<[number, number] | null>(null);

  const [fullUniforms, setFullUniforms] = useState<ShaderUniforms | null>(null);
  const [fullResProgress, setFullResProgress] = useState<number | null>(null);
  const [scale, setScale] = useState<number>(INITIAL_SCALE);
  const [center, setCenter] = useState<[number, number]>(INITIAL_CENTER);
  const [canvasResolution, setCanvasResolution] = useState<[number, number]>([
    1, 1,
  ]);

  // Mouse state
  const [isDragging, setIsDragging] = useState(false);
  const [wasDragged, setWasDragged] = useState(false);
  const [lastMousePos, setLastMousePos] = useState<[number, number]>([0, 0]);
  const [mouseWorld, setMouseWorld] = useState<[number, number] | null>(null);

  // Touch state
  const [isTouching, setIsTouching] = useState(false);
  const [wasTouched, setWasTouched] = useState(false);
  const [lastTouchPos, setLastTouchPos] = useState<[number, number]>([0, 0]);
  const [lastTouchDistance, setLastTouchDistance] = useState<number>(0);

  // Zoom by `zoomFactor`, shifting the center so the world point under
  // (clientX, clientY) stays fixed on screen.
  const zoomAt = useCallback(
    (clientX: number, clientY: number, zoomFactor: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const aspectRatio = rect.width / rect.height;
      const effSize: [number, number] = [scale * aspectRatio, scale];

      const normalizedX = (clientX - rect.left) / rect.width;
      const normalizedY = (rect.height - (clientY - rect.top)) / rect.height;

      const newScale = clampScale(scale * zoomFactor);
      const newEffSize: [number, number] = [newScale * aspectRatio, newScale];

      const centerOffsetX = (normalizedX - 0.5) * (effSize[0] - newEffSize[0]);
      const centerOffsetY = (normalizedY - 0.5) * (effSize[1] - newEffSize[1]);

      setScale(newScale);
      setCenter(
        clampCenter(
          [center[0] + centerOffsetX, center[1] + centerOffsetY],
          newEffSize,
        ),
      );
    },
    [center, scale],
  );

  // Handle mouse wheel for zooming
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 10 / 9 : 9 / 10);
    },
    [zoomAt],
  );
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, [handleWheel]);

  // Handle mouse down for panning
  const handleMouseDown = useCallback((e: MouseEvent) => {
    if (e.button === 0) {
      setIsDragging(true);
      setLastMousePos([e.clientX, e.clientY]);
    }
  }, []);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.addEventListener("mousedown", handleMouseDown);
    return () => canvas.removeEventListener("mousedown", handleMouseDown);
  }, [handleMouseDown]);

  // Handle mouse move for panning
  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging) return;

      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const aspectRatio = rect.width / rect.height;
      const effSize: [number, number] = [scale * aspectRatio, scale];

      const deltaX = (e.clientX - lastMousePos[0]) / rect.width;
      const deltaY = (e.clientY - lastMousePos[1]) / rect.height;

      const worldDeltaX = -deltaX * effSize[0];
      const worldDeltaY = deltaY * effSize[1];

      setWasDragged(true);
      setCenter(
        clampCenter(
          [center[0] + worldDeltaX, center[1] + worldDeltaY],
          effSize,
        ),
      );
      setLastMousePos([e.clientX, e.clientY]);
    },
    [isDragging, lastMousePos, scale, center],
  );
  useEffect(() => {
    document.addEventListener("mousemove", handleMouseMove);
    return () => document.removeEventListener("mousemove", handleMouseMove);
  }, [handleMouseMove]);

  // Handle mouse up for panning
  const handleMouseUp = useCallback((event: MouseEvent) => {
    if (event.button === 0) {
      setIsDragging(false);
      setWasDragged(false);
    }
  }, []);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.addEventListener("mouseup", handleMouseUp);
    return () => canvas.removeEventListener("mouseup", handleMouseUp);
  }, [handleMouseUp]);

  // Track hovered world coordinates for the on-screen readout
  const handleHover = useCallback(
    (e: MouseEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const aspectRatio = rect.width / rect.height;
      const effSize: [number, number] = [scale * aspectRatio, scale];

      const normalizedX = (e.clientX - rect.left) / rect.width;
      const normalizedY = (rect.height - (e.clientY - rect.top)) / rect.height;

      setMouseWorld([
        center[0] + (normalizedX - 0.5) * effSize[0],
        center[1] + (normalizedY - 0.5) * effSize[1],
      ]);
    },
    [scale, center],
  );
  const handleHoverEnd = useCallback(() => setMouseWorld(null), []);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.addEventListener("mousemove", handleHover);
    canvas.addEventListener("mouseleave", handleHoverEnd);
    return () => {
      canvas.removeEventListener("mousemove", handleHover);
      canvas.removeEventListener("mouseleave", handleHoverEnd);
    };
  }, [handleHover, handleHoverEnd]);

  // Handle touch start
  const handleTouchStart = useCallback((e: TouchEvent) => {
    e.preventDefault();

    switch (e.touches.length) {
      case 1:
        // Single finger - start panning
        setIsTouching(true);
        setLastTouchPos([e.touches[0].clientX, e.touches[0].clientY]);
        break;
      case 2: {
        // Two fingers - start pinch zoom
        setIsTouching(true);
        const distance = getTouchDistance(e.touches);
        setLastTouchDistance(distance);
        break;
      }
    }
  }, []);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.addEventListener("touchstart", handleTouchStart, { passive: false });
    return () => canvas.removeEventListener("touchstart", handleTouchStart);
  }, [handleTouchStart]);

  const handleTouchPan = useCallback(
    (canvas: HTMLCanvasElement, touch: Touch) => {
      const rect = canvas.getBoundingClientRect();
      const aspectRatio = rect.width / rect.height;
      const effSize: [number, number] = [scale * aspectRatio, scale];

      const deltaX = (touch.clientX - lastTouchPos[0]) / rect.width;
      const deltaY = (touch.clientY - lastTouchPos[1]) / rect.height;

      const worldDeltaX = -deltaX * effSize[0];
      const worldDeltaY = deltaY * effSize[1];

      setWasTouched(true);
      setCenter(
        clampCenter(
          [center[0] + worldDeltaX, center[1] + worldDeltaY],
          effSize,
        ),
      );
      setLastTouchPos([touch.clientX, touch.clientY]);
    },
    [scale, center, lastTouchPos],
  );

  const handleTouchZoom = useCallback(
    (touches: TouchList) => {
      const distance = getTouchDistance(touches);
      setLastTouchDistance(distance);
      if (distance === 0) {
        return;
      }

      const touchCenter = getTouchCenter(touches);
      zoomAt(touchCenter[0], touchCenter[1], lastTouchDistance / distance);
      setWasTouched(true);
    },
    [zoomAt, lastTouchDistance],
  );

  // Handle touch move
  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      e.preventDefault();

      if (!isTouching) return;

      const canvas = canvasRef.current;
      if (!canvas) return;

      switch (e.touches.length) {
        case 1:
          handleTouchPan(canvas, e.touches[0]);
          break;
        case 2:
          handleTouchZoom(e.touches);
          break;
      }
    },
    [isTouching, handleTouchPan, handleTouchZoom],
  );
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.addEventListener("touchmove", handleTouchMove, { passive: false });
    return () => canvas.removeEventListener("touchmove", handleTouchMove);
  }, [handleTouchMove]);

  // Handle touch end
  const handleTouchEnd = useCallback(
    (e: TouchEvent) => {
      e.preventDefault();

      switch (e.touches.length) {
        case 0:
          setIsTouching(false);
          setWasTouched(false);
          break;
        case 1:
          if (lastTouchDistance > 0) {
            // Went from two fingers to one - reset for panning
            setLastTouchDistance(0);
            setLastTouchPos([e.touches[0].clientX, e.touches[0].clientY]);
          }
          break;
      }
    },
    [lastTouchDistance],
  );
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.addEventListener("touchend", handleTouchEnd, { passive: false });
    return () => canvas.removeEventListener("touchend", handleTouchEnd);
  }, [handleTouchEnd]);

  // Change cursor on drag
  useEffect(() => {
    document.body.style.cursor =
      (isDragging && wasDragged) || (isTouching && wasTouched)
        ? "move"
        : "default";
  }, [isDragging, wasDragged, isTouching, wasTouched]);

  // Update fullUniforms when uniforms change. The canvas is always rendered, so
  // its ref is populated by the time this effect first runs after mount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps intentionally key on JSON.stringify(uniforms) to compare by value, and on the individual tuple elements rather than the array identities.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    setFullUniforms({
      ...uniforms,
      size: getEffectiveSize(scale, canvasResolution),
      center,
      pixelRatio: window.devicePixelRatio,
      resolution: canvasResolution,
    });
  }, [JSON.stringify(uniforms), scale, canvasResolution[0], canvasResolution[1], center[0], center[1]]);

  // Update fullUniforms when the canvas's layout box changes size. Reading the
  // canvas's own client size (rather than the window's) keeps the resolution in
  // sync with what CSS actually lays out, so the canvas never overflows.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const updateResolution = () => {
      const newResolution: [number, number] = [
        canvas.clientWidth,
        canvas.clientHeight,
      ];
      setCanvasResolution((prev) => {
        if (prev[0] === newResolution[0] && prev[1] === newResolution[1]) {
          return prev;
        }
        return newResolution;
      });
    };

    const observer = new ResizeObserver(updateResolution);
    observer.observe(canvas);

    updateResolution();

    return () => observer.disconnect();
  }, []);

  // Setup the WebGL renderer
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = BifurcationRenderer.create(canvas);
    rendererRef.current = renderer;

    return () => {
      renderer?.dispose();
      rendererRef.current = null;
    };
  }, []);

  // Render when fullUniforms changes: start an iterative low resolution
  // render right away, then an iterative full resolution render once the
  // parameters have settled. Any change cancels the renders in flight.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps intentionally key on JSON.stringify(fullUniforms) to compare by value; the render is driven only by that and lowResScaleFactor.
  useEffect(() => {
    const renderer = rendererRef.current;
    const canvas = canvasRef.current;
    if (!renderer || !canvas || !fullUniforms) return;

    setCanvasSize(
      canvas,
      fullUniforms.resolution[0],
      fullUniforms.resolution[1],
      fullUniforms.pixelRatio,
    );

    // Detect a zoom (view size changed) vs. a pan / parameter change / first
    // render. Pans and parameter changes keep today's behavior: an immediate
    // low-res render plus a 500ms debounced full-res render. Zooms instead
    // reproject the last completed frame for instant feedback and debounce the
    // low-res render by a short interval so continuous wheel events cost one
    // quad-draw each instead of a full simulation.
    const prevSize = prevSizeRef.current;
    const sizeChanged =
      prevSize !== null &&
      (prevSize[0] !== fullUniforms.size[0] ||
        prevSize[1] !== fullUniforms.size[1]);
    prevSizeRef.current = [fullUniforms.size[0], fullUniforms.size[1]];

    const timeouts: ReturnType<typeof setTimeout>[] = [];

    const startLowRes = () => {
      // Low resolution renders every step in a single chunk so panning and
      // zooming show the final image right away instead of an early iteration.
      renderer.startRender(fullUniforms, {
        scaleFactor: lowResScaleFactor,
        stepsPerChunk: fullUniforms.stepCount,
        progressive: false,
      });
    };

    if (sizeChanged && renderer.previewView(fullUniforms)) {
      // Preview succeeded: debounce the low-res render so a stream of wheel
      // events only pays for preview quad-draws until the gesture pauses.
      timeouts.push(setTimeout(startLowRes, LOW_RES_ZOOM_DELAY_MS));
    } else {
      // Preview unavailable (no completed tier yet) or this isn't a zoom:
      // render low-res immediately, same as before.
      startLowRes();
    }

    timeouts.push(
      setTimeout(() => {
        // The full resolution render keeps the low resolution image on screen
        // until it completes; the progress bar tracks it in the meantime.
        renderer.startRender(fullUniforms, {
          scaleFactor: 1,
          stepsPerChunk: FULL_RES_STEPS_PER_CHUNK,
          progressive: false,
          onProgress: setFullResProgress,
          onComplete: () => setFullResProgress(null),
        });
      }, FULL_RES_DELAY_MS),
    );

    return () => {
      for (const t of timeouts) clearTimeout(t);
      renderer.cancelRender();
      setFullResProgress(null);
    };
  }, [JSON.stringify(fullUniforms), lowResScaleFactor]);

  return (
    <>
      <canvas
        ref={canvasRef}
        className="w-full h-full"
        style={{
          imageRendering: "pixelated",
        }}
      />
      {fullResProgress !== null && (
        <div
          className="pointer-events-none fixed bottom-0 left-0 h-1 w-full bg-black/50"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(fullResProgress * 100)}
        >
          <div
            className="h-full bg-white/90"
            style={{ width: `${fullResProgress * 100}%` }}
          />
        </div>
      )}
      {mouseWorld && (
        <div className="pointer-events-none fixed right-2 bottom-2 rounded bg-black/50 px-2 py-1 font-mono text-sm text-white">
          r={formatCoord(mouseWorld[0])}, x={formatCoord(mouseWorld[1])}
        </div>
      )}
    </>
  );
}
