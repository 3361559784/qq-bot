"use client";

import React, { useEffect } from "react";
import { useRive, useStateMachineInput } from "@rive-app/react-canvas";

const RIVE_FILE = "/alice.riv";
const DEFAULT_STATE_MACHINE = "State Machine 1";

const AliceAvatar: React.FC<{ stateMachineName?: string }> = ({ stateMachineName = DEFAULT_STATE_MACHINE }) => {
  const { rive, RiveComponent } = useRive({
    src: RIVE_FILE,
    stateMachines: stateMachineName,
    autoplay: true,
  });

  const mouseXInput = useStateMachineInput(rive, stateMachineName, "mouseX");
  const mouseYInput = useStateMachineInput(rive, stateMachineName, "mouseY");
  const pokeInput = useStateMachineInput(rive, stateMachineName, "poke") || useStateMachineInput(rive, stateMachineName, "TriggerPoke");

  useEffect(() => {
    if (!mouseXInput || !mouseYInput) return;
    const onMove = (e: MouseEvent) => {
      const x = Math.max(0, Math.min(100, (e.clientX / window.innerWidth) * 100));
      const y = Math.max(0, Math.min(100, (e.clientY / window.innerHeight) * 100));
      mouseXInput.value = x;
      mouseYInput.value = y;
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [mouseXInput, mouseYInput]);

  const handlePoke = () => {
    if (pokeInput && pokeInput.fire) pokeInput.fire();
  };

  if (!RiveComponent) {
    return (
      <div className="w-48 h-48 flex items-center justify-center bg-gray-100 dark:bg-gray-800 rounded-full shadow">
        <span className="text-gray-400 text-sm">Alice</span>
      </div>
    );
  }

  return (
    <div
      className="w-48 h-48 cursor-pointer"
      onClick={handlePoke}
      title="戳一戳 Alice"
    >
      <RiveComponent style={{ width: "100%", height: "100%" }} />
    </div>
  );
};

export default AliceAvatar;
