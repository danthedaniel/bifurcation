import BifurcationCanvas, { type InputUniforms } from "~/components/BifurcationCanvas";

export default function App() {
  const uniforms: InputUniforms = { stepCount: 10000 };

  return (
    <div className="flex flex-col items-center justify-center h-screen w-full">
      <BifurcationCanvas lowResScaleFactor={10} uniforms={uniforms} />
    </div>
  );
}
