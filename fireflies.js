window.onload = function () {
  if (typeof SwissGL === "undefined") {
    console.error("SwissGL failed to load");
    return;
  }

  const canvas = document.getElementById("c");
  canvas.width = 800;
  canvas.height = 800;
  const glsl = SwissGL(canvas);

  class FireflySync {
    constructor(glsl) {
      this.glsl = glsl;
      this.step_n = 1;
      this.num_points = 20;
      this.opt = {
        releaseTime: 0.5,
        flashRadius: 0.04,
        maxSpeed: 0.001,
        maxForce: 0.00005,
        accelerationScale: 1.0,
        cohesionWeight: 1.0,
        alignmentWeight: 1.0,
        separationWeight: 1.0,
        noiseScale: 0.0001,
        separationRadius: 0.02,
        firingNoise: 0.0,
      };
      this.isScattering = false;
      this.scatterTimer = null;
      this.points = glsl(
        {},
        {
          size: [this.num_points, this.num_points],
          story: 2,
          format: "rgba32f",
          tag: "points",
        },
      );
      this.velocities = glsl(
        {},
        {
          size: [this.num_points, this.num_points],
          story: 2,
          format: "rgba32f",
          tag: "velocities",
        },
      );
      this.field = null;
      this.reset();
    }

    reset() {
      // Calculate the position of each point based on its thread ID
      this.glsl(
        {
          seed: 123,
          FP: `
        float xx = (float(I.x))/float(${this.num_points});
        float yy = (float(I.y))/float(${this.num_points});
        vec3 r = hash(ivec3(I, seed));
        FOut = vec4(r.x, r.y, r.z*TAU, fract(r.z*100.0));
        `,
        },
        this.points,
      );

      // Initialize velocities
      this.glsl(
        {
          seed: 456,
          FP: `
        vec3 r = hash(ivec3(I, seed));
        // Initialize with random velocities, for example
        FOut = vec4(r.x*0.002 - 0.001, r.y*0.002 - 0.001, 0, 0);
      `,
        },
        this.velocities,
      );
    }

    step(touch, aspect) {
      const { points, velocities, opt } = this;

      const field = (this.field = this.glsl(
        {
          Clear: 0,
          ...opt,
          aspect,
          points: points[0],
          Grid: points[0].size,
          Blend: "s+d",
          VP: `
        vec4 d = points(ID.xy);
        float flash = float(d.w==0.0);
        VPos.xy = d.xy*2.0-1.0 + flash*flashRadius*XY*aspect;`,
          FP: `smoothstep(1.0, 0.9, length(XY))`,
        },
        { size: [512, 512], warp: "edge", tag: "field" },
      ));

      // update velocities
      // First pass: Calculate and update velocities
      this.glsl(
        {
          touch,
          aspect,
          Pos: points[0],
          Vel: velocities[0],
          Grid: points[0].size,
          ...opt,
          FP: `
          vec4 p = Pos(I);
          vec4 v = Vel(I);
          
          // Parameters from C++ implementation
          // float separationRadius = 0.02;
          float alignmentRadius = 0.1;
          float cohesionRadius = 0.1;
          
          vec2 acceleration = vec2(0.0);
          vec2 separation = vec2(0);
          vec2 alignment = vec2(0);
          vec2 cohesion = vec2(0);
          float neighborCountS = 0.0;
          float neighborCountA = 0.0;
          float neighborCountC = 0.0;
          
          for(int y = 0; y < Grid.y; y++) {
            for(int x = 0; x < Grid.x; x++) {
              if(x == I.x && y == I.y) continue;
              
              vec4 otherPos = Pos(ivec2(x, y));
              // Calculate wrapped difference
              vec2 diff = otherPos.xy - p.xy;
              diff = mod(diff + 0.5, 1.0) - 0.5;  // Wrap around boundaries
              float dist = length(diff);
              
              if(dist < separationRadius) {
                separation -= normalize(diff);
                neighborCountS += 1.0;
              }
              if(dist < alignmentRadius) {
                vec4 otherVel = Vel(ivec2(x, y));
                alignment += otherVel.xy;
                neighborCountA += 1.0;
              }
              if(dist < cohesionRadius) {
                cohesion += p.xy + diff;  // Use wrapped position for cohesion
                neighborCountC += 1.0;
              }
            }
          }
          
          // Calculate steering forces
          if(neighborCountS > 0.0) {
            separation = normalize(separation / neighborCountS) * separationWeight;
          }
          if(neighborCountA > 0.0) {
            vec2 avgVelocity = alignment / neighborCountA;
            alignment = normalize(avgVelocity - v.xy) * alignmentWeight;
          }
          if(neighborCountC > 0.0) {
            vec2 center = cohesion / neighborCountC;
            cohesion = normalize(center - p.xy) * cohesionWeight;
          }

          // Add forces to acceleration
          acceleration += separation + alignment + cohesion;
          
          // Limit acceleration
          float accLength = length(acceleration);

          if(accLength > maxForce) {
            acceleration = normalize(acceleration) * maxForce;
          }
          
          // Apply acceleration to velocity
          v.xy += acceleration * accelerationScale;
          
          // Add noise
          vec2 noise = vec2(
            fract(sin(dot(p.xy, vec2(12.9898, 78.233))) * 43758.5453),
            fract(sin(dot(p.xy, vec2(93.9898, 67.345))) * 43758.5453)
          ) * 2.0 - 1.0;
          v.xy += noise * noiseScale;
          
          // Limit velocity
          float speed = length(v.xy);
          if(speed > maxSpeed) {
            v.xy = normalize(v.xy) * maxSpeed;
          }

          FOut = v;
        `,
        },
        velocities,
      ); // Write to velocities buffer

      // simulation step
      this.glsl(
        {
          touch,
          aspect,
          field,
          Vel: velocities[0],
          points: points[0],
          Grid: points[0].size,
          ...opt,
          FP: `
        vec4 d = Src(I);
        vec4 v = Vel(I);

        // Wrap position using mod instead of fract
        d.xy = mod(d.xy + v.xy, 1.0);
        vec3 rng = hash(ivec3(d.xyz*12345.0));
        
        // Remove the boundary reset since we're wrapping
        d.z += rng.x-0.5;
        float sense = field(d.xy).r * step(releaseTime, d.w);
        if (firingNoise>0.0) {
          d.w = d.w+0.005 + sense*0.05;
          d.w += (rng.x-0.5)*0.1;
        }
        else {
          d.w = d.w+0.001 + sense*0.05;
        }
        if (d.w>1.0) { d.w = 0.0;}
        if (touch.z>0.0 && length((touch.xy-d.xy)/aspect)<0.1) {
          d.w = rng.x;
        }
        // add noise to d.w
        // float noise = rng.x-0.5;
        // d.w += noise*0.01;
        FOut = d;
      `,
        },
        points,
      );
    }

    frame(params) {
      const [w, h] = params.canvasSize,
        r = w + h,
        aspect = [r / w, r / h];
      let [x, y, press] = params.pointer;
      [x, y] = [x / w + 0.5, y / h + 0.5];
      const touch = [x, y, press];

      for (let i = 0; i < this.step_n; ++i) {
        this.step(touch, aspect);
      }

      const { points, opt } = this;

      this.glsl({
        Clear: [1.0, 1.0, 1.0, 1.0],
        aspect,
        points: points[0],
        Grid: points[0].size,
        Blend: "s",
        ...opt,
        VP: ` // used to be s + d
        vec4 point = points(ID.xy);
        float flash = exp(-point.w*point.w*400.0);
        varying vec3 color;
        color = mix(vec3(0.5, 0.5, 0.5), vec3(0.5, 0.5, 0.5), flash);
        float r = mix(0.003, 0.008, flash);
        VPos.xy = (point.xy)*2.0-1.0+r*XY*aspect;`,

        FP: `color*smoothstep(0.5, 0.5, length(XY)),1.0`,
      });
    }
  }

  const firefly = new FireflySync(glsl);
  let isCanvasVisible = true;

  // Create intersection observer
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        isCanvasVisible = entry.isIntersecting;
      });
    },
    {
      threshold: 0, // Trigger as soon as even one pixel is visible
    },
  );

  // Start observing the canvas
  observer.observe(canvas);

  function animate(t) {
    // Only animate if canvas is visible
    if (!isCanvasVisible) {
      requestAnimationFrame(animate);
      return;
    }

    // const rect = canvas.getBoundingClientRect();
    const pointer = [0, 0, 0];
    firefly.frame({
      time: t / 1000,
      canvasSize: [canvas.width, canvas.height],
      pointer,
    });
    requestAnimationFrame(animate);
  }

  function radicalize() {
    firefly.opt.separationWeight = 10.0;
    firefly.opt.firingNoise = 0.01;
    firefly.opt.separationRadius = 0.03;
    firefly.isScattering = true;

    if (firefly.scatterTimer) {
      clearTimeout(firefly.scatterTimer);
    }

    firefly.scatterTimer = setTimeout(() => {
      firefly.opt.separationWeight = 1.0;
      firefly.opt.separationRadius = 0.02;
      firefly.isScattering = false;
      firefly.opt.firingNoise = 0.0;
    }, 300);
  }

  // Add mouse move event listener
  window.addEventListener("mousemove", () => {
    radicalize();
  });

  // Existing scroll event listener
  window.addEventListener("scroll", () => {
    radicalize();
  });

  requestAnimationFrame(animate);
};

