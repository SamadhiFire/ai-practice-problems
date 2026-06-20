package io.dcloud.feature.uniapp.bridge;

public interface UniJSCallback {
    void invoke(Object value);

    void invokeAndKeepAlive(Object value);
}
