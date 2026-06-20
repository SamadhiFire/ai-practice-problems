package org.json;

import java.util.Iterator;

public class JSONObject {
    public JSONObject() {
    }

    public JSONObject(String source) {
    }

    public JSONObject put(String name, Object value) {
        return this;
    }

    public JSONObject put(String name, boolean value) {
        return this;
    }

    public JSONObject put(String name, int value) {
        return this;
    }

    public JSONObject put(String name, double value) {
        return this;
    }

    public String optString(String name) {
        return "";
    }

    public String optString(String name, String fallback) {
        return fallback;
    }

    public boolean optBoolean(String name, boolean fallback) {
        return fallback;
    }

    public int optInt(String name, int fallback) {
        return fallback;
    }

    public double optDouble(String name, double fallback) {
        return fallback;
    }

    public Iterator<String> keys() {
        return null;
    }

    public Object get(String name) {
        return null;
    }
}
