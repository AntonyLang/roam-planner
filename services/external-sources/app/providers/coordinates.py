"""Coordinate conversion matching TREK shared/src/geo/gcj02.ts."""
import math

def wgs84_to_gcj02(lat, lng):
    if not (72.004 <= lng <= 137.8347 and .8293 <= lat <= 55.8271): return lat, lng
    x, y, pi = lng - 105, lat - 35, math.pi
    a, ee = 6378245., .006693421622965943
    common = (20*math.sin(6*x*pi) + 20*math.sin(2*x*pi))*2/3
    dlat = -100+2*x+3*y+.2*y*y+.1*x*y+.2*math.sqrt(abs(x))+common
    dlat += (20*math.sin(y*pi)+40*math.sin(y*pi/3))*2/3
    dlat += (160*math.sin(y*pi/12)+320*math.sin(y*pi/30))*2/3
    dlng = 300+x+2*y+.1*x*x+.1*x*y+.1*math.sqrt(abs(x))+common
    dlng += (20*math.sin(x*pi)+40*math.sin(x*pi/3))*2/3
    dlng += (150*math.sin(x*pi/12)+300*math.sin(x*pi/30))*2/3
    radians=lat*pi/180; magic=1-ee*math.sin(radians)**2; root=math.sqrt(magic)
    return lat+dlat*180/((a*(1-ee)/(magic*root))*pi), lng+dlng*180/((a/root)*math.cos(radians)*pi)

def gcj02_to_wgs84(lat, lng):
    guess_lat, guess_lng = lat, lng
    for _ in range(10):
        forward_lat, forward_lng = wgs84_to_gcj02(guess_lat, guess_lng)
        delta_lat, delta_lng = forward_lat-lat, forward_lng-lng
        if max(abs(delta_lat), abs(delta_lng)) < 1e-9: break
        guess_lat -= delta_lat; guess_lng -= delta_lng
    return guess_lat, guess_lng

def point(value):
    if not isinstance(value, dict): return None
    lat, lng = value.get('latitude', value.get('lat')), value.get('longitude', value.get('lng'))
    try: lat, lng = float(lat), float(lng)
    except (ValueError, TypeError): return None
    if not (math.isfinite(lat) and math.isfinite(lng) and -90 <= lat <= 90 and -180 <= lng <= 180): return None
    return lat, lng
