#!/usr/bin/env bash
# The disk bench/vulkan/godot.ts gives the guest (dev-only): Godot's arm64 build (4.7.2, sha256-pinned; its zip holds
# one binary) at /godot and test projects at /projects/<name>/, the same scene (a box, a camera, a sun, a plain
# background) under Forward+ (`forward`) and Mobile (`mobile`), a lit one with SDFGI on (`sdfgi`, Forward+), and Godot's
# Global Illumination demo (`gi`: godot-demo-projects' 3d/global_illumination from Godot's asset store, MIT, sha256-pinned;
# GD G8).
#   bench/vulkan/godot-disk.sh      -> target/godot/godot.ext4 (the download kept in target/godot/dl/)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=$ROOT/target/godot
VERSION=4.7.2 SHA256=5dd0d86405cf7e8adf79fb6377b38ba682a2846cb378ffe5364f38c01ad29b9d
mkdir -p "$OUT/dl"
zip=$OUT/dl/godot-$VERSION.zip
if ! echo "$SHA256  $zip" | sha256sum -c --quiet >/dev/null 2>&1; then
  curl -sSLf -o "$zip" "https://github.com/godotengine/godot/releases/download/$VERSION-stable/Godot_v$VERSION-stable_linux.arm64.zip"
  echo "$SHA256  $zip" | sha256sum -c --quiet
fi
tree=$(mktemp -d "${TMPDIR:-/tmp}/godot-disk.XXXXXX")
trap 'rm -rf "$tree"' EXIT
python3 -I -c 'import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); open(sys.argv[2], "wb").write(z.read(z.namelist()[0]))' "$zip" "$tree/godot"
chmod +x "$tree/godot"
for p in forward mobile; do
  method=forward_plus feature='Forward Plus'
  [ $p = mobile ] && method=mobile feature=Mobile
  mkdir -p "$tree/projects/$p"
  cat > "$tree/projects/$p/project.godot" <<EOF
config_version=5

[application]
config/name="probe3d"
run/main_scene="res://main.tscn"
config/features=PackedStringArray("4.7", "$feature")

[rendering]
renderer/rendering_method="$method"
EOF
  cat > "$tree/projects/$p/main.tscn" <<'EOF'
[gd_scene load_steps=4 format=3]

[sub_resource type="BoxMesh" id="1"]
[sub_resource type="StandardMaterial3D" id="2"]
albedo_color = Color(0.9, 0.3, 0.2, 1)
[sub_resource type="Environment" id="3"]
background_mode = 1
background_color = Color(0.2, 0.4, 0.8, 1)

[node name="Main" type="Node3D"]

[node name="Box" type="MeshInstance3D" parent="."]
mesh = SubResource("1")
surface_material_override/0 = SubResource("2")
transform = Transform3D(0.8, 0, 0.6, 0, 1, 0, -0.6, 0, 0.8, 0, 0, 0)

[node name="Camera" type="Camera3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0.5, 3)

[node name="Sun" type="DirectionalLight3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 0.7, 0.7, 0, -0.7, 0.7, 0, 2, 0)

[node name="Env" type="WorldEnvironment" parent="."]
environment = SubResource("3")
EOF
done
# GD G4: SDFGI (Forward+ only), whose compute stages read up to 15 storage images: a floor and a box under a sun with
# shadows, the environment's SDFGI on (`sdfgi`).
mkdir -p "$tree/projects/sdfgi"
sed 's/probe3d/sdfgi/' "$tree/projects/forward/project.godot" > "$tree/projects/sdfgi/project.godot"
cat > "$tree/projects/sdfgi/main.tscn" <<'EOF'
[gd_scene load_steps=7 format=3]

[sub_resource type="BoxMesh" id="1"]

[sub_resource type="StandardMaterial3D" id="2"]
albedo_color = Color(0.9, 0.3, 0.2, 1)

[sub_resource type="PlaneMesh" id="4"]
size = Vector2(12, 12)

[sub_resource type="StandardMaterial3D" id="5"]
albedo_color = Color(0.8, 0.8, 0.8, 1)

[sub_resource type="Environment" id="3"]
background_mode = 1
background_color = Color(0.2, 0.4, 0.8, 1)
ambient_light_source = 2
ambient_light_color = Color(0.3, 0.3, 0.3, 1)
sdfgi_enabled = true

[node name="Main" type="Node3D"]

[node name="Floor" type="MeshInstance3D" parent="."]
mesh = SubResource("4")
surface_material_override/0 = SubResource("5")
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, -0.5, 0)

[node name="Box" type="MeshInstance3D" parent="."]
mesh = SubResource("1")
surface_material_override/0 = SubResource("2")
transform = Transform3D(0.8, 0, 0.6, 0, 1, 0, -0.6, 0, 0.8, 0, 0, 0)

[node name="Camera" type="Camera3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 0.95, 0.31, 0, -0.31, 0.95, 0, 1.5, 4)

[node name="Sun" type="DirectionalLight3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 0.7, 0.7, 0, -0.7, 0.7, 0, 2, 0)
shadow_enabled = true

[node name="Env" type="WorldEnvironment" parent="."]
environment = SubResource("3")
EOF
# The same with SDFGI's work at its least (`sdfgi-least`): one cascade, the fewest rays a probe and frames to converge.
mkdir -p "$tree/projects/sdfgi-least"
sed 's/sdfgi_enabled = true/sdfgi_enabled = true\nsdfgi_cascades = 1/' "$tree/projects/sdfgi/main.tscn" > "$tree/projects/sdfgi-least/main.tscn"
printf '%s\n' "$(cat "$tree/projects/sdfgi/project.godot")" 'global_illumination/sdfgi/probe_ray_count=0' \
  'global_illumination/sdfgi/frames_to_converge=0' 'global_illumination/sdfgi/frames_to_update_lights=0' \
  > "$tree/projects/sdfgi-least/project.godot"
# GD G8: the Global Illumination demo (LightmapGI, VoxelGI, SDFGI, a reflection probe, SSAO and SSIL over a level).
GI_SHA256=13c05a05fc84becca76ee9d3b81a6b6a417ac516ff2402f969fe30c7ded49a06
gi=$OUT/dl/3d_global_illumination.zip
if ! echo "$GI_SHA256  $gi" | sha256sum -c --quiet >/dev/null 2>&1; then
  curl -sSLf -o "$gi" "https://store.godotengine.org/asset/godot-foundation/global-illumination-demo/download/3295/"
  echo "$GI_SHA256  $gi" | sha256sum -c --quiet
fi
python3 -I -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$gi" "$tree/gi"
mv "$tree/gi/global_illumination" "$tree/projects/gi" && rmdir "$tree/gi"
rm -f "$OUT/godot.ext4"
/sbin/mkfs.ext4 -q -d "$tree" "$OUT/godot.ext4" 400M
echo "$OUT/godot.ext4"
