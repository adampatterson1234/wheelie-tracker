WHEELIE TRACKER PWA v3

New in v3:
- No longer trusts iPhone raw coords.speed for wheelie distance.
- Calculates speed from consecutive high-accuracy GPS positions.
- Uses a rolling median / smoothed speed to reduce jumpiness.
- Rejects implausible GPS spikes.
- Ignores tiny GPS movements near the location-accuracy noise floor.
- Wheelie distance is accumulated from accepted GPS path segments.
- Keeps live wheelie angle, max current angle and best angle.

Important:
GPS still has physical limits on very short wheelies. Angle and time will usually be much more precise than distance for events lasting only a few seconds.
