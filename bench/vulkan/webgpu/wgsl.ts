// The scene's shaders in WGSL, written by hand as a WebGPU author would (arm 2; bench/vulkan/REPORT.md), from the same
// Aquarium shaders as bench/vulkan/scene/shaders/ (ported from the WebGL Aquarium, BSD-3-Clause:
// bench/vulkan/scene/LICENSE.aquarium). One module, every entry point; the groups:
//   0: the frame's uniforms, the skybox, a clamping sampler
//   1: a material's three textures and its sampler
//   2: the object's uniforms (a dynamic offset), the fish (storage), the bubbles' constants and sets, the light rays
//   3: the fish at a dynamic offset (fish mode "dynamic" only)
// How a fish's data reaches its draw is the mode: "storage" (the frame's fish written once, a draw's firstInstance
// picks its own), "dynamic" (a uniform buffer bound at the fish's offset for every draw), "immediates" (pushed per draw).

export type FishMode = 'storage' | 'dynamic' | 'immediates';

export function sceneWgsl(mode: FishMode): string {
  const fishDecl = {
    storage: '',
    dynamic: '@group(3) @binding(0) var<uniform> fishU: Fish;',
    immediates: 'var<immediate> fishI: Fish;',
  }[mode];
  const fishOf = { storage: 'fishes[ii]', dynamic: 'fishU', immediates: 'fishI' }[mode];
  return /* wgsl */ `
${mode === 'immediates' ? 'requires immediate_address_space;' : ''}
struct Globals {
  viewProjection: mat4x4f,
  viewInverse: mat4x4f,
  viewProjectionNoRotation: mat4x4f,
  lightWorldPos: vec4f,
  ambient: vec4f,
  fogColor: vec4f,
  fogParams: vec4f,
  innerParams: vec4f,
  clock: vec4f,
}
struct Object {
  world: mat4x4f,
  worldInverseTranspose: mat4x4f,
  params: vec4f,
}
struct Fish {
  worldPosition: vec3f,
  scale: f32,
  nextPosition: vec3f,
  time: f32,
  fishLength: f32,
  fishWaveLength: f32,
  fishBendAmount: f32,
  pad: f32,
}
struct Bubble {
  positionStartTime: vec4f,
  velocityStartSize: vec4f,
  accelerationEndSize: vec4f,
  lifeTimeSpin: vec4f,
}
struct Ray {
  world: mat4x4f,
  colorMult: vec4f,
}

@group(0) @binding(0) var<uniform> g: Globals;
@group(0) @binding(1) var skybox: texture_cube<f32>;
@group(0) @binding(2) var skySampler: sampler;
@group(1) @binding(0) var diffuseTex: texture_2d<f32>;
@group(1) @binding(1) var normalTex: texture_2d<f32>;
@group(1) @binding(2) var reflectionTex: texture_2d<f32>;
@group(1) @binding(3) var matSampler: sampler;
@group(2) @binding(0) var<uniform> o: Object;
@group(2) @binding(1) var<storage, read> fishes: array<Fish>;
@group(2) @binding(2) var<storage, read> bubbles: array<Bubble>;
@group(2) @binding(3) var<storage, read> bubbleSets: array<vec4f>;
@group(2) @binding(4) var<storage, read> rays: array<Ray>;
${fishDecl}

override FOG: bool = true;

struct VIn {
  @location(0) position: vec4f,
  @location(1) normal: vec3f,
  @location(2) texCoord: vec2f,
  @location(3) tangent: vec3f,
  @location(4) binormal: vec3f,
}
struct V {
  @builtin(position) clip: vec4f,
  @location(0) position: vec4f,
  @location(1) texCoord: vec2f,
  @location(2) tangent: vec3f,
  @location(3) binormal: vec3f,
  @location(4) normal: vec3f,
  @location(5) surfaceToLight: vec3f,
  @location(6) surfaceToView: vec3f,
}

fn lit(l: f32, h: f32, m: f32) -> vec4f {
  return vec4f(1.0, max(l, 0.0), select(0.0, pow(max(0.0, h), m), l > 0.0), 1.0);
}

fn fog(outColor: vec4f, position: vec4f, alpha: f32) -> vec4f {
  if (!FOG) { return outColor; }
  return mix(outColor, vec4f(g.fogColor.rgb, alpha),
             clamp(pow(position.z / position.w, g.fogParams.x) * g.fogParams.y - g.fogParams.z, 0.0, 1.0));
}

@vertex fn vs_object(i: VIn) -> V {
  var v: V;
  v.texCoord = i.texCoord;
  v.position = g.viewProjection * o.world * i.position;
  v.normal = (o.worldInverseTranspose * vec4f(i.normal, 0)).xyz;
  v.surfaceToLight = g.lightWorldPos.xyz - (o.world * i.position).xyz;
  v.surfaceToView = (g.viewInverse[3] - (o.world * i.position)).xyz;
  v.binormal = (o.worldInverseTranspose * vec4f(i.binormal, 0)).xyz;
  v.tangent = (o.worldInverseTranspose * vec4f(i.tangent, 0)).xyz;
  v.clip = v.position;
  return v;
}

@vertex fn vs_fish(i: VIn, @builtin(instance_index) ii: u32) -> V {
  let f = ${fishOf};
  let vz = normalize(f.worldPosition - f.nextPosition);
  let vx = normalize(cross(vec3f(0, 1, 0), vz));
  let vy = cross(vz, vx);
  let orientMat = mat4x4f(vec4f(vx, 0), vec4f(vy, 0), vec4f(vz, 0), vec4f(f.worldPosition, 1));
  let scaleMat = mat4x4f(vec4f(f.scale, 0, 0, 0), vec4f(0, f.scale, 0, 0), vec4f(0, 0, f.scale, 0), vec4f(0, 0, 0, 1));
  let world = orientMat * scaleMat;
  var v: V;
  v.texCoord = i.texCoord;
  let mult = select(-i.position.z / f.fishLength * 2.0, i.position.z / f.fishLength, i.position.z > 0.0);
  let s = sin(f.time + mult * f.fishWaveLength);
  let offset = pow(mult, 2.0) * s * f.fishBendAmount;
  v.position = g.viewProjection * world * (i.position + vec4f(offset, 0, 0, 0));
  v.normal = (world * vec4f(i.normal, 0)).xyz;
  v.surfaceToLight = g.lightWorldPos.xyz - (world * i.position).xyz;
  v.surfaceToView = (g.viewInverse[3] - (world * i.position)).xyz;
  v.binormal = (world * vec4f(i.binormal, 0)).xyz;
  v.tangent = (world * vec4f(i.tangent, 0)).xyz;
  v.clip = v.position;
  return v;
}

@vertex fn vs_seaweed(i: VIn) -> V {
  let toCamera = normalize(g.viewInverse[3].xyz - o.world[3].xyz);
  let yAxis = vec3f(0, 1, 0);
  let xAxis = cross(yAxis, toCamera);
  let newWorld = mat4x4f(vec4f(xAxis, 0), vec4f(yAxis, 0), vec4f(xAxis, 0), o.world[3]);
  var v: V;
  v.texCoord = i.texCoord;
  let p = i.position + vec4f(sin(o.params.x * 0.5) * pow(i.position.y * 0.07, 2.0) * 1.0, -4, 0, 0);
  v.position = (g.viewProjection * newWorld) * p;
  v.normal = (newWorld * vec4f(i.normal, 0)).xyz;
  v.surfaceToLight = g.lightWorldPos.xyz - (o.world * i.position).xyz;
  v.surfaceToView = (g.viewInverse[3] - (o.world * i.position)).xyz;
  v.clip = v.position;
  return v;
}

@fragment fn fs_diffuse(v: V) -> @location(0) vec4f {
  let diffuseColor = textureSample(diffuseTex, matSampler, v.texCoord);
  let normal = normalize(v.normal);
  let surfaceToLight = normalize(v.surfaceToLight);
  let surfaceToView = normalize(v.surfaceToView);
  let halfVector = normalize(surfaceToLight + surfaceToView);
  let litR = lit(dot(normal, surfaceToLight), dot(normal, halfVector), o.params.y);
  let outColor = vec4f((diffuseColor * litR.y + diffuseColor * g.ambient + litR.z * o.params.z).rgb, diffuseColor.a);
  return fog(outColor, v.position, diffuseColor.a);
}

@fragment fn fs_normalmap(v: V) -> @location(0) vec4f {
  let diffuseColor = textureSample(diffuseTex, matSampler, v.texCoord);
  let tangentToWorld = mat3x3f(v.tangent, v.binormal, v.normal);
  let normalSpec = textureSample(normalTex, matSampler, v.texCoord);
  let tangentNormal = normalSpec.xyz - vec3f(0.5, 0.5, 0.5);
  let normal = normalize(tangentToWorld * tangentNormal);
  let surfaceToLight = normalize(v.surfaceToLight);
  let surfaceToView = normalize(v.surfaceToView);
  let halfVector = normalize(surfaceToLight + surfaceToView);
  let litR = lit(dot(normal, surfaceToLight), dot(normal, halfVector), o.params.y);
  let outColor = vec4f((diffuseColor * litR.y + diffuseColor * g.ambient + litR.z * o.params.z * normalSpec.a).rgb, diffuseColor.a);
  return fog(outColor, v.position, diffuseColor.a);
}

@fragment fn fs_reflection(v: V) -> @location(0) vec4f {
  let diffuseColor = textureSample(diffuseTex, matSampler, v.texCoord);
  let tangentToWorld = mat3x3f(v.tangent, v.binormal, v.normal);
  let normalSpec = textureSample(normalTex, matSampler, v.texCoord);
  let reflection = textureSample(reflectionTex, matSampler, v.texCoord);
  let tangentNormal = normalSpec.xyz - vec3f(0.5, 0.5, 0.5);
  let normal = normalize(tangentToWorld * tangentNormal);
  let surfaceToLight = normalize(v.surfaceToLight);
  let surfaceToView = normalize(v.surfaceToView);
  let skyColor = textureSample(skybox, skySampler, -reflect(surfaceToView, normal));
  let halfVector = normalize(surfaceToLight + surfaceToView);
  let litR = lit(dot(normal, surfaceToLight), dot(normal, halfVector), o.params.y);
  let outColor = vec4f(mix(skyColor, diffuseColor * litR.y + diffuseColor * g.ambient + litR.z * o.params.z * normalSpec.a,
                           1.0 - reflection.r).rgb, diffuseColor.a);
  return fog(outColor, v.position, diffuseColor.a);
}

@fragment fn fs_inner(v: V) -> @location(0) vec4f {
  let fudge = g.innerParams.z;
  let diffuseColor = textureSample(diffuseTex, matSampler, v.texCoord) + vec4f(fudge, fudge, fudge, 1);
  let tangentToWorld = mat3x3f(v.tangent, v.binormal, v.normal);
  let normalSpec = textureSample(normalTex, matSampler, v.texCoord);
  let refraction = textureSample(reflectionTex, matSampler, v.texCoord);
  var tangentNormal = normalSpec.xyz - vec3f(0.5, 0.5, 0.5);
  tangentNormal = normalize(tangentNormal + vec3f(0, 0, g.innerParams.x));
  let normal = normalize(tangentToWorld * tangentNormal);
  let surfaceToView = normalize(v.surfaceToView);
  let refractionVec = refract(surfaceToView, normal, g.innerParams.y);
  let skyColor = textureSample(skybox, skySampler, refractionVec);
  let outColor = vec4f(mix(skyColor * diffuseColor, diffuseColor, refraction.r).rgb, diffuseColor.a);
  return fog(outColor, v.position, diffuseColor.a);
}

@fragment fn fs_outer(v: V) -> @location(0) vec4f {
  let diffuseColor = textureSample(diffuseTex, matSampler, v.texCoord);
  let tangentToWorld = mat3x3f(v.tangent, v.binormal, v.normal);
  let normalSpec = textureSample(normalTex, matSampler, v.texCoord);
  let reflection = textureSample(reflectionTex, matSampler, v.texCoord);
  let tangentNormal = normalSpec.xyz - vec3f(0.5, 0.5, 0.5);
  let normal = normalize(tangentToWorld * tangentNormal);
  let surfaceToView = normalize(v.surfaceToView);
  let skyColor = textureSample(skybox, skySampler, -reflect(surfaceToView, normal));
  let fudge = skyColor.rgb * vec3f(1.1);
  let bright = min(1.0, fudge.r * fudge.g * fudge.b);
  let reflectColor = mix(vec4f(skyColor.rgb, bright), diffuseColor, 1.0 - reflection.r);
  let r = abs(dot(surfaceToView, normal));
  return vec4f(mix(skyColor, reflectColor, (r + 0.3) * reflection.r).rgb, 1.0 - r);
}

@fragment fn fs_fishnormal(v: V) -> @location(0) vec4f {
  let diffuseColor = textureSample(diffuseTex, matSampler, v.texCoord);
  let tangentToWorld = mat3x3f(v.tangent, v.binormal, v.normal);
  let normalSpec = textureSample(normalTex, matSampler, v.texCoord);
  var tangentNormal = normalSpec.xyz - vec3f(0.5, 0.5, 0.5);
  tangentNormal = normalize(tangentNormal + vec3f(0, 0, 2));
  let normal = normalize(tangentToWorld * tangentNormal);
  let surfaceToLight = normalize(v.surfaceToLight);
  let surfaceToView = normalize(v.surfaceToView);
  let halfVector = normalize(surfaceToLight + surfaceToView);
  let litR = lit(dot(normal, surfaceToLight), dot(normal, halfVector), 5.0);
  let outColor = vec4f((diffuseColor * litR.y + diffuseColor * g.ambient + litR.z * 0.3 * normalSpec.a).rgb, diffuseColor.a);
  return fog(outColor, v.position, diffuseColor.a);
}

@fragment fn fs_fishreflect(v: V) -> @location(0) vec4f {
  let diffuseColor = textureSample(diffuseTex, matSampler, v.texCoord);
  let tangentToWorld = mat3x3f(v.tangent, v.binormal, v.normal);
  let normalSpec = textureSample(normalTex, matSampler, v.texCoord);
  let reflection = textureSample(reflectionTex, matSampler, v.texCoord);
  let tangentNormal = normalSpec.xyz - vec3f(0.5, 0.5, 0.5);
  let normal = normalize(tangentToWorld * tangentNormal);
  let surfaceToLight = normalize(v.surfaceToLight);
  let surfaceToView = normalize(v.surfaceToView);
  let skyColor = textureSample(skybox, skySampler, -reflect(surfaceToView, normal));
  let halfVector = normalize(surfaceToLight + surfaceToView);
  let litR = lit(dot(normal, surfaceToLight), dot(normal, halfVector), 5.0);
  let outColor = vec4f(mix(skyColor, diffuseColor * litR.y + diffuseColor * g.ambient + litR.z * 0.3 * normalSpec.a,
                           1.0 - reflection.r).rgb, diffuseColor.a);
  return fog(outColor, v.position, diffuseColor.a);
}

@fragment fn fs_seaweed(v: V) -> @location(0) vec4f {
  let diffuseColor = textureSample(diffuseTex, matSampler, v.texCoord);
  if (diffuseColor.a < 0.3) { discard; }
  let normal = normalize(v.normal);
  let surfaceToLight = normalize(v.surfaceToLight);
  let surfaceToView = normalize(v.surfaceToView);
  let halfVector = normalize(surfaceToLight + surfaceToView);
  let litR = lit(dot(normal, surfaceToLight), dot(normal, halfVector), o.params.y);
  let outColor = vec4f((diffuseColor * litR.y + diffuseColor * g.ambient + litR.z * o.params.z).rgb, diffuseColor.a);
  return fog(outColor, v.position, diffuseColor.a);
}

struct BubbleV {
  @builtin(position) clip: vec4f,
  @location(0) texCoord: vec2f,
  @location(1) percentLife: f32,
}

// A set's 100 bubbles are instances set * 100 .. set * 100 + 99 (the draw's firstInstance picks the set).
@vertex fn vs_bubble(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> BubbleV {
  let corners = array(vec2f(-0.5, -0.5), vec2f(0.5, -0.5), vec2f(-0.5, 0.5), vec2f(0.5, 0.5));
  let b = bubbles[ii % 100u];
  let bset = bubbleSets[ii / 100u];
  let uv = corners[vi];
  let localTime = g.clock.x - bset.w - b.positionStartTime.w;
  let percentLife = localTime / b.lifeTimeSpin.x;
  var size = mix(b.velocityStartSize.w, b.accelerationEndSize.w, percentLife);
  size = select(size, 0.0, percentLife < 0.0 || percentLife > 1.0);
  let center = b.velocityStartSize.xyz * localTime + b.accelerationEndSize.xyz * localTime * localTime +
               b.positionStartTime.xyz + bset.xyz;
  let p = center + (g.viewInverse[0].xyz * uv.x + g.viewInverse[1].xyz * uv.y) * size;
  var v: BubbleV;
  v.texCoord = uv + 0.5;
  v.percentLife = percentLife;
  v.clip = g.viewProjection * vec4f(p, 1);
  return v;
}

@fragment fn fs_bubble(v: BubbleV) -> @location(0) vec4f {
  let alpha = clamp((1.0 - v.percentLife) * 5.0, 0.0, 1.0);
  return textureSample(diffuseTex, matSampler, v.texCoord) * vec4f(0.7, 0.8, 1.0, alpha);
}

struct RayV {
  @builtin(position) clip: vec4f,
  @location(0) texCoord: vec2f,
  @location(1) @interpolate(flat) ray: u32,
}

@vertex fn vs_ray(i: VIn, @builtin(instance_index) ii: u32) -> RayV {
  var v: RayV;
  v.texCoord = i.texCoord;
  v.ray = ii;
  v.clip = g.viewProjectionNoRotation * rays[ii].world * i.position;
  return v;
}

@fragment fn fs_ray(v: RayV) -> @location(0) vec4f {
  return textureSample(diffuseTex, matSampler, v.texCoord) * rays[v.ray].colorMult;
}

struct TkIn {
  @builtin(vertex_index) vi: u32,
  @location(0) rect: vec4f,
  @location(1) uv: vec4f,
  @location(2) color: vec4f,
}
struct TkV {
  @builtin(position) clip: vec4f,
  @location(0) texCoord: vec2f,
  @location(1) color: vec4f,
  @location(2) local: vec2f,
  @location(3) shape: vec4f,
}

@vertex fn vs_tk(i: TkIn) -> TkV {
  let corners = array(vec2f(0, 0), vec2f(1, 0), vec2f(0, 1), vec2f(1, 1));
  let c = corners[i.vi];
  var v: TkV;
  v.texCoord = mix(i.uv.xy, i.uv.zw, c);
  v.color = i.color;
  v.local = c * i.rect.zw;
  v.shape = vec4f(i.rect.zw, i.uv.xy);
  v.clip = g.viewProjection * vec4f(i.rect.xy + c * i.rect.zw, 0, 1);
  return v;
}

@fragment fn fs_tktexture(v: TkV) -> @location(0) vec4f {
  return textureSample(diffuseTex, matSampler, v.texCoord) * v.color;
}

@fragment fn fs_tkcolor(v: TkV) -> @location(0) vec4f {
  return v.color;
}

@fragment fn fs_tkrounded(v: TkV) -> @location(0) vec4f {
  let size = v.shape.xy;
  let radius = v.shape.z;
  let border = v.shape.w;
  let q = abs(v.local - size * 0.5) - (size * 0.5 - radius);
  let d = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - radius;
  let inside = clamp(0.5 - d, 0.0, 1.0);
  let edge = clamp(0.5 - abs(d + border * 0.5) + border * 0.5, 0.0, 1.0);
  let rgb = mix(v.color.rgb, vec3f(0.75, 0.76, 0.8), edge);
  return vec4f(rgb, v.color.a * inside);
}
`;
}
